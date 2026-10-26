import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { ConnectAccount, type ConnectionsView, type ProjectConnectionsView } from '@lovbase/core/connections'
import { ConfigService } from '../../config/config.service'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { DomainError, NotFound } from '../../common/errors'
import { randomId } from '../../common/ids'
import type { ProjectCtx, UserCtx } from '../auth/access.service'
import { ComposioService } from './composio.service'

type Connection = { id: string; user_id: string; account_id: string; auth_config_id: string; label: string; state: string; return_path: string
  toolkit: string; app_name: string; logo: string | null; auth_scheme: string; identity: string | null; identity_id: string | null; created_at: Date; synced_at: Date | null; connected_at: Date | null }
@Injectable()
export class ConnectionsService {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService, private readonly cfg: ConfigService, private readonly composio: ComposioService) {}
  get enabled() { return this.composio.enabled }

  async list(ctx: UserCtx, refresh = false): Promise<ConnectionsView> {
    await this.schema.ready()
    const result = await this.pool.query<Connection>('SELECT * FROM public.lb_connections WHERE user_id = $1 AND connected_at IS NOT NULL ORDER BY created_at DESC', [ctx.user.id])
    let syncFailed = false
    if (this.enabled) await Promise.all(result.rows.map(async c => {
      if (c.state === 'disconnected' || !refresh && c.synced_at && Date.now() - new Date(c.synced_at).getTime() < 60_000) return
      try {
        const remote = await this.composio.account(ctx.user.id, c.account_id, c.auth_config_id, c.toolkit)
        const profile = remote.active && (!c.identity || refresh) ? await this.composio.profile(c.account_id, c.toolkit) : null
        const state = remote.active ? 'active' : ['INITIATED', 'INITIALIZING'].includes(remote.status) ? 'pending' : 'expired'
        await this.pool.query(`UPDATE public.lb_connections SET state = $2, identity = COALESCE($3, identity), identity_id = COALESCE($5, identity_id), synced_at = now()
          WHERE id = $1 AND account_id = $4 AND state <> 'disconnected'`, [c.id, state, profile?.identity || remote.identity || null, c.account_id, profile?.identityId ?? null])
      } catch { syncFailed = true }
    }))
    const rows = await this.pool.query<Connection>('SELECT * FROM public.lb_connections WHERE user_id = $1 AND connected_at IS NOT NULL ORDER BY created_at DESC', [ctx.user.id])
    const refs = await this.pool.query<{ connection_id: string; id: string; name: string }>(`SELECT pc.connection_id, p.id, p.name FROM public.lb_project_connection_accounts pc
      JOIN public.lb_projects p ON p.id = pc.project_id JOIN public.lb_connections c ON c.id = pc.connection_id
      WHERE c.user_id = $1 AND p.owner_id = $1 ORDER BY p.name`, [ctx.user.id])
    return { enabled: this.enabled, syncFailed, connections: rows.rows.map(c => ({
      id: c.id, toolkit: c.toolkit, appName: c.app_name, logo: c.logo, authScheme: c.auth_scheme,
      label: c.label, identity: c.identity, state: c.state, createdAt: new Date(c.created_at).toISOString(),
      syncedAt: c.synced_at ? new Date(c.synced_at).toISOString() : null,
      projects: refs.rows.filter(r => r.connection_id === c.id).map(r => ({ id: r.id, name: r.name })),
    })) }
  }
  async projectState(ctx: ProjectCtx): Promise<ProjectConnectionsView> {
    const state = await this.list(ctx)
    const refs = await this.pool.query('SELECT connection_id FROM public.lb_project_connection_accounts WHERE project_id = $1', [ctx.project.id])
    const defs = await this.pool.query(`SELECT d.toolkit, d.connection_id FROM public.lb_project_connection_defaults d
      JOIN public.lb_connections c ON c.id = d.connection_id AND c.user_id = $2 AND c.state = 'active'
      JOIN public.lb_project_connection_accounts pc ON pc.project_id = d.project_id AND pc.connection_id = d.connection_id
      WHERE d.project_id = $1`, [ctx.project.id, ctx.user.id])
    const defaults: Record<string, string> = Object.fromEntries(defs.rows.map(r => [r.toolkit, r.connection_id]))
    return { ...state, enabledIds: refs.rows.map(r => r.connection_id), defaults, selectedId: defaults.googlesheets ?? null }
  }
  async owned(userId: string, id: string): Promise<Connection> {
    await this.schema.ready()
    const result = await this.pool.query<Connection>('SELECT * FROM public.lb_connections WHERE id = $1 AND user_id = $2', [id, userId])
    if (!result.rows[0]) throw new NotFound('Connection not found.')
    return result.rows[0]
  }
  private async authConfig(toolkit: string, scheme: 'OAUTH2' | 'OAUTH1' | 'API_KEY') {
    if (toolkit === 'googlesheets' && scheme === 'OAUTH2' && this.cfg.env.COMPOSIO_SHEETS_AUTH_CONFIG_ID) return this.cfg.env.COMPOSIO_SHEETS_AUTH_CONFIG_ID
    const key = toolkit === 'googlesheets' && scheme === 'OAUTH2' ? 'composio_sheets_auth_config' : `composio_auth:${toolkit}:${scheme}`
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
      const result = await client.query('SELECT value FROM public.lb_settings WHERE key = $1', [key])
      const id: string = result.rows[0]?.value?.id ?? await this.composio.createAuthConfig(toolkit, scheme)
      await client.query('INSERT INTO public.lb_settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify({ id })])
      await client.query('COMMIT')
      return id
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  catalog(query: string, cursor?: string) { return this.composio.catalog(query, cursor) }
  authentication(toolkit: string) { return this.composio.authentication(toolkit) }
  async begin(ctx: UserCtx, label: string, projectId?: string) {
    return this.connect(ctx, { toolkit: 'googlesheets', label, projectId, fields: {} })
  }
  async connect(ctx: UserCtx, raw: ConnectAccount) {
    const input = ConnectAccount.parse(raw)
    await this.schema.ready()
    if (input.projectId) {
      const p = await this.pool.query('SELECT 1 FROM public.lb_projects WHERE id = $1 AND owner_id = $2', [input.projectId, ctx.user.id])
      if (!p.rowCount) throw new NotFound('Project not found.')
    }
    const previous = input.reconnectId ? await this.owned(ctx.user.id, input.reconnectId) : null
    if (previous && (previous.toolkit !== input.toolkit || previous.state === 'disconnected')) throw new DomainError('Add a new account instead.')
    const auth = await this.composio.authentication(input.toolkit)
    const method = auth.methods.find(m => m.scheme === (previous?.auth_scheme ?? input.authScheme)) ?? (!previous && !input.authScheme ? auth.methods[0] : undefined)
    if (!method) throw new DomainError('This authentication method needs administrator configuration.')
    const fields: Record<string, string> = {}
    for (const f of method.fields) {
      const value = input.fields[f.name]
      if (f.required && !value?.trim()) throw new DomainError(`Required field: ${f.label}`)
      if (value) fields[f.name] = value
    }
    const authConfigId = previous?.auth_config_id ?? await this.authConfig(input.toolkit, method.scheme)
    const state = randomId(40), id = previous?.id ?? 'cn_' + randomId(20)
    const path = (input.returnPath ?? (input.projectId ? `/projects/${input.projectId}` : '/settings')) + '#connections=connected&view=dialog'
    const callback = new URL('/api/integrations/callback', this.cfg.env.BETTER_AUTH_URL)
    callback.searchParams.set('state', state)
    const request = method.scheme === 'API_KEY'
      ? { accountId: await this.composio.connectKey(ctx.user.id, authConfigId, fields), url: null }
      : await this.composio.authorize(ctx.user.id, authConfigId, callback.href, input.toolkit)
    try {
      if (!previous) await this.pool.query(`INSERT INTO public.lb_connections
        (id, user_id, account_id, auth_config_id, label, return_path, toolkit, app_name, logo, auth_scheme)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, ctx.user.id, request.accountId, authConfigId, input.label, path, input.toolkit, auth.app.name, auth.app.logo, method.scheme])
      await this.pool.query(`INSERT INTO public.lb_connection_attempts(state, user_id, connection_id, account_id, return_path) VALUES ($1,$2,$3,$4,$5)`,
        [state, ctx.user.id, id, request.accountId, path])
    } catch (error) { await this.composio.disconnect(request.accountId, ctx.user.id, input.toolkit).catch(() => {}); throw error }
    if (method.scheme === 'API_KEY') {
      let remote
      try { remote = await this.composio.account(ctx.user.id, request.accountId, authConfigId, input.toolkit) }
      catch { await this.failAttempt(state, id, request.accountId); throw new DomainError('Could not verify this connection. Please retry.') }
      if (!remote.active) {
        await this.failAttempt(state, id, request.accountId)
        throw new DomainError('These credentials were not accepted. Check the fields and retry.')
      }
      const returnPath = await this.complete(ctx, state, request.accountId, 'success')
      if (returnPath.includes('identity_changed')) throw new DomainError('This is a different external account. Use Add account instead.')
      return { url: null, id }
    }
    return { url: request.url, id }
  }
  private async failAttempt(state: string, id: string, accountId: string) {
    await this.pool.query('UPDATE public.lb_connection_attempts SET consumed_at = now() WHERE state = $1', [state])
    await this.pool.query("UPDATE public.lb_connections SET state = 'failed', callback_state = NULL WHERE id = $1 AND state = 'pending' AND account_id = $2", [id, accountId])
    await this.composio.disconnect(accountId).catch(() => {})
  }
  async complete(ctx: UserCtx, state: string, accountId: string | undefined, status: string) {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT a.* FROM public.lb_connection_attempts a JOIN public.lb_connections c ON c.id = a.connection_id
      WHERE a.state = $1 AND a.user_id = $2 AND c.user_id = $2 AND a.consumed_at IS NULL
      AND a.created_at > now() - interval '30 minutes' AND c.state <> 'disconnected'`, [state, ctx.user.id])
    const attempt = r.rows[0]
    if (!attempt || accountId && attempt.account_id !== accountId || status === 'success' && !accountId) throw new DomainError('This authorization link is invalid or expired. Connect again.')
    accountId = attempt.account_id as string
    const c = await this.owned(ctx.user.id, attempt.connection_id)
    const back = (notice: string) => attempt.return_path.split('#')[0] + `#connections=${notice}&view=dialog`
    if (status !== 'success') { await this.failAttempt(state, c.id, accountId); return back('failed') }
    const remote = await this.composio.account(ctx.user.id, accountId, c.auth_config_id, c.toolkit)
    if (!remote.active) { await this.failAttempt(state, c.id, accountId); return back('failed') }
    const profile = await this.composio.profile(accountId, c.toolkit)
    const identity = profile.identity || remote.identity || null
    if (accountId !== c.account_id && (c.identity_id && profile.identityId ? c.identity_id !== profile.identityId : c.identity && identity && c.identity !== identity)) {
      await this.failAttempt(state, c.id, accountId)
      return back('identity_changed')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const consumed = await client.query(`UPDATE public.lb_connection_attempts SET consumed_at = now() WHERE state = $1 AND consumed_at IS NULL RETURNING state`, [state])
      if (!consumed.rowCount) throw new DomainError('This authorization was already completed.')
      const changed = await client.query(`UPDATE public.lb_connections SET account_id = $2, state = 'active', callback_state = NULL,
        identity = COALESCE($3, identity), identity_id = COALESCE($4, identity_id), synced_at = now(), connected_at = COALESCE(connected_at, now())
        WHERE id = $1 AND state <> 'disconnected' AND account_id = $5 RETURNING id`, [c.id, accountId, identity, profile.identityId, c.account_id])
      if (!changed.rowCount) throw new DomainError('The connection changed. Reconnect again.')
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    await (this.composio as ComposioService & { recordConnectionOperation?: ComposioService['recordConnectionOperation'] })
      .recordConnectionOperation?.(ctx.user.id, accountId, 'authorize_complete', c.toolkit)
    if (accountId !== c.account_id) await this.composio.disconnect(c.account_id, ctx.user.id, c.toolkit).catch(() => {})
    return back('connected')
  }
  async rename(ctx: UserCtx, id: string, label: string) {
    await this.owned(ctx.user.id, id)
    await this.pool.query('UPDATE public.lb_connections SET label = $2 WHERE id = $1', [id, label])
    return { ok: true }
  }
  async setEnabled(ctx: ProjectCtx, id: string, enabled: boolean) {
    const c = await this.owned(ctx.user.id, id)
    if (enabled && (c.state !== 'active' || !(await this.composio.account(ctx.user.id, c.account_id, c.auth_config_id, c.toolkit)).active))
      throw new DomainError('Reconnect this account before enabling it.')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const project = await client.query('SELECT id FROM public.lb_projects WHERE id = $1 AND owner_id = $2 FOR UPDATE', [ctx.project.id, ctx.user.id])
      if (!project.rowCount) throw new NotFound('Project not found.')
      if (enabled) {
        const active = await client.query("SELECT id FROM public.lb_connections WHERE id = $1 AND state = 'active' FOR UPDATE", [id])
        if (!active.rowCount) throw new DomainError('This account was disconnected.')
        await client.query('INSERT INTO public.lb_project_connection_accounts VALUES ($1,$2) ON CONFLICT DO NOTHING', [ctx.project.id, id])
        // A null row records that a previous default was explicitly removed. Never replace it implicitly.
        await client.query(`INSERT INTO public.lb_project_connection_defaults(project_id, toolkit, connection_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.project.id, c.toolkit, id])
      } else {
        await client.query('DELETE FROM public.lb_project_connection_accounts WHERE project_id = $1 AND connection_id = $2', [ctx.project.id, id])
        await client.query('UPDATE public.lb_project_connection_defaults SET connection_id = NULL WHERE project_id = $1 AND connection_id = $2', [ctx.project.id, id])
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    return { ok: true }
  }
  async select(ctx: ProjectCtx, id: string | null) {
    if (id) {
      const c = await this.owned(ctx.user.id, id)
      if (c.toolkit !== 'googlesheets') throw new DomainError('Select a Google Sheets account.')
      await this.setDefault(ctx, id)
    } else await this.pool.query("UPDATE public.lb_project_connection_defaults SET connection_id = NULL WHERE project_id = $1 AND toolkit = 'googlesheets'", [ctx.project.id])
    return this.projectState(ctx)
  }
  async setDefault(ctx: ProjectCtx, id: string) {
    const c = await this.owned(ctx.user.id, id)
    const result = await this.pool.query(`INSERT INTO public.lb_project_connection_defaults(project_id, toolkit, connection_id)
      SELECT $1, c.toolkit, c.id FROM public.lb_connections c JOIN public.lb_project_connection_accounts pc ON pc.connection_id = c.id
      JOIN public.lb_projects p ON p.id = pc.project_id AND p.owner_id = $3
      WHERE c.id = $2 AND c.user_id = $3 AND c.state = 'active' AND pc.project_id = $1
      ON CONFLICT (project_id, toolkit) DO UPDATE SET connection_id = EXCLUDED.connection_id RETURNING connection_id`, [ctx.project.id, id, ctx.user.id])
    if (!result.rowCount) throw new DomainError('Enable this account in the project first.')
    return { ok: true, toolkit: c.toolkit }
  }
  async active(userId: string, projectId: string, db: Pick<pg.PoolClient, 'query'> = this.pool, connectionId?: string) {
    await this.schema.ready()
    const result = await db.query<Connection>(`SELECT c.* FROM public.lb_project_connection_accounts pc JOIN public.lb_connections c ON c.id = pc.connection_id
      JOIN public.lb_projects p ON p.id = pc.project_id LEFT JOIN public.lb_project_connection_defaults d ON d.project_id = pc.project_id AND d.toolkit = c.toolkit
      WHERE pc.project_id = $1 AND p.owner_id = $2 AND c.user_id = $2 AND c.state = 'active' AND c.toolkit = 'googlesheets'
      AND c.id = COALESCE($3, d.connection_id) FOR SHARE OF c, pc`, [projectId, userId, connectionId ?? null])
    if (!result.rows[0]) throw new DomainError(connectionId ? 'This Sheets account is no longer enabled for this project.' : 'Choose a default Google Sheets account for this project first.')
    return result.rows[0]
  }
  async disconnect(ctx: UserCtx, id: string) {
    const c = await this.owned(ctx.user.id, id)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("UPDATE public.lb_connections SET state = 'disconnected', callback_state = NULL WHERE id = $1", [id])
      await client.query('DELETE FROM public.lb_project_connection_accounts WHERE connection_id = $1', [id])
      await client.query('UPDATE public.lb_project_connection_defaults SET connection_id = NULL WHERE connection_id = $1', [id])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    const pending = await this.pool.query('SELECT account_id FROM public.lb_connection_attempts WHERE connection_id = $1', [id])
    for (const accountId of new Set([c.account_id, ...pending.rows.map(a => a.account_id as string)])) await this.composio.disconnect(accountId, ctx.user.id, c.toolkit)
    await this.pool.query('DELETE FROM public.lb_connections WHERE id = $1', [id])
    return { ok: true }
  }
}
