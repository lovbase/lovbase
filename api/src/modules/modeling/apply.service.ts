import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import type { Change } from '@lovbase/core/diff'
import { changeToSQL } from '@lovbase/core/ddl'
import type { IR } from '@lovbase/core/ir'
import { InjectPool } from '../../database/pool.provider'
import { ProjectsService, schemaFor } from '../projects/projects.service'

export type Pending = { next: IR; changes: Change[]; stale: boolean }

/** Turns an approved diff into DDL, in one transaction, and records what happened. */
@Injectable()
export class ApplyService {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly projects: ProjectsService) {}

  async apply(projectId: string, next: IR, changes: Change[], note = 'Applied') {
    const schema = schemaFor(projectId)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const change of changes)
        for (const sql of changeToSQL(change, next, schema)) await client.query(sql)
      // `COALESCE(NULLIF(...))`: an IR the model left unnamed carries the schema default, and
      // writing that over a name the user or the first turn chose is how a named project went
      // back to being "Untitled project" the next time anything touched the schema.
      await client.query(
        `UPDATE public.lb_projects SET ir = $2, name = COALESCE(NULLIF($3, ''), name), updated_at = now() WHERE id = $1`,
        [projectId, JSON.stringify(next), next.appName === 'Untitled' ? '' : next.appName])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      await this.projects.log(projectId, 'error', { message: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      client.release()
    }
    await this.projects.log(projectId, 'agent', { note, changes })
  }

  // Pending confirmations survive restarts: stored in PG, not memory.
  // `base` is the IR the proposal was diffed against; confirming later against a different IR
  // would silently overwrite newer changes, so `take` checks it.

  async savePending(projectId: string, id: string, base: IR, next: IR, changes: Change[]) {
    await this.pool.query(
      `INSERT INTO public.lb_pending (id, project_id, base_ir, next_ir, changes) VALUES ($1, $2, $3, $4, $5)`,
      [id, projectId, JSON.stringify(base), JSON.stringify(next), JSON.stringify(changes)])
  }

  /** Removes the pending row and reports whether the project's IR moved since it was proposed. */
  async takePending(projectId: string, id: string, currentIR: IR): Promise<Pending | null> {
    const r = await this.pool.query(
      `DELETE FROM public.lb_pending WHERE id = $1 AND project_id = $2 RETURNING base_ir, next_ir, changes`, [id, projectId])
    if (r.rows.length === 0) return null
    const base = r.rows[0].base_ir as IR | null
    const stale = !base || JSON.stringify(base) !== JSON.stringify(currentIR)
    return { next: r.rows[0].next_ir as IR, changes: r.rows[0].changes as Change[], stale }
  }

  async listPendingIds(projectId: string): Promise<string[]> {
    const r = await this.pool.query(`SELECT id FROM public.lb_pending WHERE project_id = $1`, [projectId])
    return r.rows.map((x) => x.id as string)
  }
}
