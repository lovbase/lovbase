import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { InjectPool, InjectSqlPool } from '../../database/pool.provider'
import { SqlError } from '../../common/errors'
import { MAX_ROWS, STATEMENT_TIMEOUT_MS, prepareStatement } from './statement'

export type SqlResult = {
  rows: Record<string, unknown>[]
  rowCount: number
  fields: string[]
  truncated: boolean
  kind: 'read' | 'write'
}

export type TableInfo = {
  name: string
  rows: number
  columns: { name: string; type: string; nullable: boolean; pk: boolean; fkTable: string | null; hasDefault: boolean }[]
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`

/** Postgres error codes worth turning into something other than a 400. */
function asSqlError(err: unknown): SqlError {
  if (err instanceof SqlError) return err
  const e = err as { code?: string; message: string; position?: string }
  const status = e.code === '42501' ? 403 : e.code === '57014' ? 408 : 400 // privilege / statement_timeout
  return new SqlError(e.message + (e.position ? ` (at position ${e.position})` : ''), status)
}

/** SQL over HTTP for one workspace: always as the workspace role, always one statement, always in a transaction. */
@Injectable()
export class SqlService {
  constructor(
    @InjectSqlPool() private readonly pool: pg.Pool,
    @InjectPool() private readonly ownerPool: pg.Pool,
  ) {}

  private async scoped<T>(role: string, schema: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL ROLE ${ident(role)}`)
      await client.query(`SET LOCAL search_path = ${ident(schema)}`)
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw asSqlError(err)
    } finally {
      client.release()
    }
  }

  async run(role: string, schema: string, raw: string, params: unknown[] = []): Promise<SqlResult> {
    const p = prepareStatement(raw)
    return this.scoped(role, schema, async (client) => {
      // `values` is always an array → extended protocol → single statement enforced by PG.
      const r = await client.query({ text: p.text, values: params })
      const truncated = p.kind === 'read' && r.rows.length > MAX_ROWS
      return {
        rows: truncated ? r.rows.slice(0, MAX_ROWS) : r.rows,
        rowCount: p.kind === 'read' ? Math.min(r.rows.length, MAX_ROWS) : r.rowCount ?? 0,
        fields: r.fields?.map((f) => f.name) ?? [],
        truncated,
        kind: p.kind,
      }
    })
  }

  /** Several statements in ONE transaction, same guards. Used by the table editor's commit. */
  async runBatch(role: string, schema: string, statements: { sql: string; params?: unknown[] }[]): Promise<{ affected: number }> {
    const prepared = statements.map((s) => ({ ...prepareStatement(s.sql), params: s.params ?? [] }))
    return this.scoped(role, schema, async (client) => {
      let affected = 0
      for (const p of prepared) {
        const r = await client.query({ text: p.text, values: p.params })
        affected += r.rowCount ?? 0
      }
      return { affected }
    })
  }

  /** Real column metadata for the workspace schema, straight from the catalog. */
  async introspect(schema: string): Promise<TableInfo[]> {
    const r = await this.ownerPool.query(
      `SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable = 'YES' AS nullable, c.column_default,
              EXISTS (
                SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
                WHERE tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND tc.constraint_type = 'PRIMARY KEY' AND k.column_name = c.column_name
              ) AS pk,
              (SELECT ccu.table_name FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
                JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
                WHERE tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND tc.constraint_type = 'FOREIGN KEY' AND k.column_name = c.column_name LIMIT 1) AS fk_table
       FROM information_schema.columns c
       WHERE c.table_schema = $1
       ORDER BY c.table_name, c.ordinal_position`, [schema])
    const tables = new Map<string, TableInfo>()
    for (const row of r.rows) {
      const t = tables.get(row.table_name) ?? { name: row.table_name as string, rows: 0, columns: [] }
      t.columns.push({
        name: row.column_name, type: row.udt_name, nullable: row.nullable,
        pk: row.pk, fkTable: row.fk_table, hasDefault: row.column_default != null,
      })
      tables.set(row.table_name, t)
    }
    const counts = await Promise.all([...tables.keys()].map(async (t) => {
      const c = await this.ownerPool.query(`SELECT count(*)::int AS n FROM ${ident(schema)}.${ident(t)}`)
      return [t, c.rows[0].n as number] as const
    }))
    const countMap = new Map(counts)
    return [...tables.values()].map((t) => ({ ...t, rows: countMap.get(t.name) ?? 0 }))
  }
}
