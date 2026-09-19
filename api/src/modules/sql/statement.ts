import { SqlError } from '../../common/errors'

// ── Statement preparation, kept pure so it can be unit-tested without a database ──
// Safety comes from Postgres, not from parsing:
//  1. the statement runs as the workspace role (no DDL, no other schemas),
//  2. it goes through the extended protocol (parameters array always present),
//     which makes Postgres itself reject multi-statement strings,
//  3. role / search_path / timeout are SET LOCAL inside one transaction, so nothing
//     leaks into the next request that reuses the pooled connection.
// The keyword whitelist is only there to reject things that are pointless or noisy.

export const MAX_ROWS = 1000
export const STATEMENT_TIMEOUT_MS = 5000

const ALLOWED = ['select', 'with', 'insert', 'update', 'delete', 'values', 'table'] as const
const READS = new Set(['select', 'with', 'values', 'table'])

export type Prepared = { text: string; kind: 'read' | 'write' }

/** Strip comments and a trailing semicolon; classify; wrap reads in a LIMIT. */
export function prepareStatement(raw: string): Prepared {
  let sql = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim()
  sql = sql.replace(/;+\s*$/, '').trim()
  if (!sql) throw new SqlError('empty statement')
  if (sql.includes(';')) throw new SqlError('one statement per request')
  const kw = sql.match(/^[a-z]+/i)?.[0].toLowerCase() ?? ''
  if (!(ALLOWED as readonly string[]).includes(kw))
    throw new SqlError(`only ${ALLOWED.join('/').toUpperCase()} are allowed here; schema changes go through the builder`)
  const kind = READS.has(kw) ? 'read' : 'write'
  const text = kind === 'read' ? `SELECT * FROM (${sql}) AS _q LIMIT ${MAX_ROWS + 1}` : sql
  return { text, kind }
}
