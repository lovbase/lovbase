import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { ConfigService } from '../../config/config.service'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { DomainError, NotFound } from '../../common/errors'
import { randomId } from '../../common/ids'
import type { ProjectCtx, UserCtx } from '../auth/access.service'
import { ComposioService } from './composio.service'

type Connection = { id: string; user_id: string; account_id: string; auth_config_id: string; label: string; state: string; return_path: string }
@Injectable()
export class ConnectionsService {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService, private readonly cfg: ConfigService, private readonly composio: ComposioService) {}
  get enabled() { return this.composio.enabled }

  async list(ctx: UserCtx) {
    if (!this.enabled) return { enabled: false, connections: [] as { id: string; label: string; state: string }[] }
    await this.schema.ready()
    const result = await this.pool.query('SELECT id, label, state FROM public.lb_connections WHERE user_id = $1 ORDER BY created_at DESC', [ctx.user.id])
    return { enabled: true, connections: result.rows as { id: string; label: string; state: string }[] }
  }
  async projectState(ctx: ProjectCtx) {
    const state = await this.list(ctx)
    if (!state.enabled) return { ...state, selectedId: null as string | null }
    const result = await this.pool.query('SELECT connection_id FROM public.lb_project_connections WHERE project_id = $1', [ctx.project.id])
    return { ...state, selectedId: result.rows[0]?.connection_id as string | undefined ?? null }
  }
  async owned(userId: string, id: string): Promise<Connection> {
    await this.schema.ready()
    const result = await this.pool.query('SELECT * FROM public.lb_connections WHERE id = $1 AND user_id = $2', [id, userId])
    if (!result.rows[0]) throw new NotFound('Connection not found.')
    return result.rows[0]
  }
  private async authConfig() {
    if (this.cfg.env.COMPOSIO_SHEETS_AUTH_CONFIG_ID) return this.cfg.env.COMPOSIO_SHEETS_AUTH_CONFIG_ID
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtext('lovbase:composio-auth-config'))")
      const result = await client.query("SELECT value FROM public.lb_settings WHERE key = 'composio_sheets_auth_config'")
      const id: string = result.rows[0]?.value?.id ?? await this.composio.createAuthConfig()
      await client.query("INSERT INTO public.lb_settings(key, value) VALUES ('composio_sheets_auth_config', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify({ id })])
      await client.query('COMMIT')
      return id
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async begin(ctx: UserCtx, label: string, projectId?: string) {
    await this.schema.ready()
    // The optional project is independently checked, including when called by an Agent tool.
    if (projectId) {
      const owned = await this.pool.query('SELECT 1 FROM public.lb_projects WHERE id = $1 AND owner_id = $2', [projectId, ctx.user.id])
      if (!owned.rowCount) throw new NotFound('Project not found.')
    }
    const state = randomId(40), id = 'cn_' + randomId(20)
    const authConfigId = await this.authConfig()
    const callback = new URL('/api/integrations/google/callback', this.cfg.env.BETTER_AUTH_URL)
    callback.searchParams.set('state', state)
    const request = await this.composio.authorize(ctx.user.id, authConfigId, callback.href)
    await this.pool.query(`INSERT INTO public.lb_connections (id, user_id, account_id, auth_config_id, label, callback_state, return_path)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, ctx.user.id, request.accountId, authConfigId, label, state, projectId ? `/projects/${projectId}` : '/settings'])
    return { url: request.url }
  }
  async complete(ctx: UserCtx, state: string, accountId: string, status: string) {
    await this.schema.ready()
    const result = await this.pool.query(`SELECT * FROM public.lb_connections WHERE callback_state = $1 AND user_id = $2 AND state = 'pending' AND created_at > now() - interval '30 minutes'`, [state, ctx.user.id])
    const connection: Connection | undefined = result.rows[0]
    if (!connection || connection.account_id !== accountId) throw new DomainError('This authorization link is invalid or expired. Connect again.')
    if (status !== 'success') {
      await this.pool.query("UPDATE public.lb_connections SET state = 'failed', callback_state = NULL WHERE id = $1", [connection.id])
      return connection.return_path
    }
    const remote = await this.composio.account(ctx.user.id, accountId, connection.auth_config_id)
    if (!remote.active) throw new DomainError('Google authorization is not active. Connect again.')
    const changed = await this.pool.query("UPDATE public.lb_connections SET state = 'active', callback_state = NULL WHERE id = $1 AND state = 'pending' RETURNING id", [connection.id])
    if (!changed.rowCount) throw new DomainError('This authorization was already completed or disconnected.')
    return connection.return_path
  }
  async select(ctx: ProjectCtx, id: string | null) {
    if (id) {
      const connection = await this.owned(ctx.user.id, id)
      if (connection.state !== 'active' || !(await this.composio.account(ctx.user.id, connection.account_id, connection.auth_config_id)).active)
        throw new DomainError('This connection is no longer active. Reconnect first.')
      await this.pool.query(`INSERT INTO public.lb_project_connections(project_id, connection_id) VALUES ($1, $2)
        ON CONFLICT (project_id) DO UPDATE SET connection_id = EXCLUDED.connection_id`, [ctx.project.id, id])
    } else await this.pool.query('DELETE FROM public.lb_project_connections WHERE project_id = $1', [ctx.project.id])
    return this.projectState(ctx)
  }
  async active(userId: string, projectId: string, db: Pick<pg.PoolClient, 'query'> = this.pool) {
    await this.schema.ready()
    const result = await db.query(`SELECT c.* FROM public.lb_project_connections pc JOIN public.lb_connections c ON c.id = pc.connection_id
      JOIN public.lb_projects p ON p.id = pc.project_id WHERE pc.project_id = $1 AND p.owner_id = $2 AND c.user_id = $2 AND c.state = 'active'`, [projectId, userId])
    if (!result.rows[0]) throw new DomainError('Enable a Google Sheets connection for this project first.')
    return result.rows[0] as Connection
  }
  async disconnect(ctx: UserCtx, id: string) {
    const c = await this.owned(ctx.user.id, id)
    // Deny new local use immediately, even if remote revocation needs a retry.
    await this.pool.query("UPDATE public.lb_connections SET state = 'disconnected', callback_state = NULL WHERE id = $1", [id])
    await this.pool.query('DELETE FROM public.lb_project_connections WHERE connection_id = $1', [id])
    await this.composio.disconnect(c.account_id)
    await this.pool.query('DELETE FROM public.lb_connections WHERE id = $1', [id])
    return { ok: true }
  }
}
