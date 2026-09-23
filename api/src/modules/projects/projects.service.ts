import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { emptyIR } from '@lovbase/core/ir'
import { DEFAULT_APP_NAME } from '../apps/apps.service'
import { qi } from '@lovbase/core/ddl'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { RolesService, schemaFor } from '../roles/roles.service'
import { randomId } from '../../common/ids'
import { NotFound } from '../../common/errors'
import type { LogEntry, Project } from './project.types'

export { schemaFor }

@Injectable()
export class ProjectsService {
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly schema: SchemaService,
    private readonly roles: RolesService,
  ) {}

  /** Creates the row, the schema and the workspace role together; any failure rolls all three back. */
  async create(ownerId: string, fixedId?: string): Promise<Project> {
    await this.schema.ready()
    const id = fixedId ?? 'a' + randomId(11) // leading letter keeps p_<id> a legal identifier and the id readable
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`CREATE SCHEMA ${qi(schemaFor(id))}`)
      const r = await client.query(
        `INSERT INTO public.lb_projects (id, owner_id, ir, api_token) VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, ownerId, JSON.stringify(emptyIR()), 'lb_' + randomId(32)])
      await client.query(`INSERT INTO public.lb_apps (id, project_id, name) VALUES ($1, $1, $2)`, [id, DEFAULT_APP_NAME])
      await client.query('COMMIT')
      await this.roles.ensureWorkspaceRole(id)
      return r.rows[0] as Project
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  /** The display name. Set by the modeler from the IR, or by `NamingService` on the first turn. */
  async setName(projectId: string, name: string) {
    await this.pool.query(`UPDATE public.lb_projects SET name = $2, updated_at = now() WHERE id = $1`, [projectId, name])
  }

  /**
   * The project list, each row carrying the app whose cover represents it — the one photographed
   * most recently. Joined on `cover_at`, not `published_at`: publishing is what triggers a
   * photograph, but it can fail, and anything published before covers existed never had one. A
   * lateral join rather than a query per card, and no guessing: a card that guesses is a 404.
   */
  async listFor(ownerId: string): Promise<(Project & { cover_app_id: string | null; cover_at: Date | null })[]> {
    await this.schema.ready()
    const r = await this.pool.query(
      `SELECT p.*, a.id AS cover_app_id, a.cover_at
         FROM public.lb_projects p
         LEFT JOIN LATERAL (
           SELECT id, cover_at FROM public.lb_apps
            WHERE project_id = p.id AND cover_at IS NOT NULL
            ORDER BY cover_at DESC LIMIT 1
         ) a ON true
        WHERE p.owner_id = $1
        ORDER BY p.updated_at DESC`, [ownerId])
    return r.rows as (Project & { cover_app_id: string | null; cover_at: Date | null })[]
  }

  async find(id: string): Promise<Project | null> {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT * FROM public.lb_projects WHERE id = $1`, [id])
    return (r.rows[0] as Project) ?? null
  }

  async get(id: string): Promise<Project> {
    const p = await this.find(id)
    if (!p) throw new NotFound('Project not found')
    return p
  }

  /** Backfill for projects created before api tokens existed. */
  async ensureApiToken(p: Project): Promise<Project> {
    if (p.api_token) return p
    const token = 'lb_' + randomId(32)
    await this.pool.query(`UPDATE public.lb_projects SET api_token = $2 WHERE id = $1 AND api_token IS NULL`, [p.id, token])
    return { ...p, api_token: token }
  }

  async findByApiToken(token: string): Promise<Project | null> {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT * FROM public.lb_projects WHERE api_token = $1`, [token])
    return (r.rows[0] as Project) ?? null
  }

  async findByShareToken(token: string): Promise<Project | null> {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT * FROM public.lb_projects WHERE share_token = $1`, [token])
    return (r.rows[0] as Project) ?? null
  }

  async setReadOnly(id: string, readOnly: boolean) {
    await this.pool.query(`UPDATE public.lb_projects SET read_only = $2 WHERE id = $1`, [id, readOnly])
  }

  async setShareToken(id: string, token: string | null) {
    await this.pool.query(`UPDATE public.lb_projects SET share_token = $2 WHERE id = $1`, [id, token])
  }

  /** Drops the schema, the rows and the workspace role. Containers are reclaimed by the caller first. */
  async remove(id: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`DROP SCHEMA IF EXISTS ${qi(schemaFor(id))} CASCADE`)
      await client.query(`DELETE FROM public.lb_app_files WHERE app_id IN (SELECT id FROM public.lb_apps WHERE project_id = $1)`, [id])
      await client.query(`DELETE FROM public.lb_projects WHERE id = $1`, [id])
      await client.query('COMMIT')
      await this.roles.dropWorkspaceRole(id)
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  async log(projectId: string, role: string, content: unknown) {
    await this.pool.query(`INSERT INTO public.lb_log (project_id, role, content) VALUES ($1, $2, $3)`,
      [projectId, role, JSON.stringify(content)])
  }

  async history(projectId: string): Promise<LogEntry[]> {
    const r = await this.pool.query(
      `SELECT id, role, content, created_at FROM public.lb_log WHERE project_id = $1 ORDER BY id ASC LIMIT 500`, [projectId])
    return r.rows as LogEntry[]
  }
}
