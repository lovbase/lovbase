import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { qi } from '@lovbase/core/ddl'
import type { IR } from '@lovbase/core/ir'
import { InjectPool } from '../../database/pool.provider'
import { schemaFor } from '../roles/roles.service'
import { DomainError, NotFound } from '../../common/errors'

/**
 * Row CRUD against a project's schema, driven by the IR rather than by client-supplied column
 * names. Callers have already resolved the project (and therefore authorization).
 */
@Injectable()
export class RowsService {
  constructor(@InjectPool() private readonly pool: pg.Pool) {}

  private table(projectId: string, ir: IR, entityId: string) {
    const e = ir.entities.find((x) => x.id === entityId)
    if (!e) throw new NotFound('unknown entity')
    return { e, ref: `${qi(schemaFor(projectId))}.${qi(e.dbName)}` }
  }

  async list(projectId: string, ir: IR, entityId: string) {
    const { ref } = this.table(projectId, ir, entityId)
    const r = await this.pool.query(`SELECT * FROM ${ref} ORDER BY created_at DESC LIMIT 200`)
    return r.rows
  }

  async insert(projectId: string, ir: IR, entityId: string, values: Record<string, unknown>) {
    const { e, ref } = this.table(projectId, ir, entityId)
    const cols: string[] = []
    const params: unknown[] = []
    for (const [fieldId, value] of Object.entries(values)) {
      const f = e.fields.find((x) => x.id === fieldId)
      if (!f || value === '' || value == null) continue
      cols.push(qi(f.dbName))
      params.push(f.type === 'number' ? Number(value) : value)
    }
    if (cols.length === 0) throw new DomainError('empty row')
    const placeholders = params.map((_, i) => `$${i + 1}`).join(', ')
    const r = await this.pool.query(`INSERT INTO ${ref} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, params)
    return r.rows[0]
  }

  async remove(projectId: string, ir: IR, entityId: string, rowId: string) {
    const { ref } = this.table(projectId, ir, entityId)
    await this.pool.query(`DELETE FROM ${ref} WHERE id = $1`, [rowId])
  }
}
