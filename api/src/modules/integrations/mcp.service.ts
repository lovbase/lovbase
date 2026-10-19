import { Injectable, Logger } from '@nestjs/common'
import type pg from 'pg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ConfigService } from '../../config/config.service'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { CryptoService } from '../crypto/crypto.service'
import { DomainError, NotFound } from '../../common/errors'
import type { ProjectCtx, UserCtx } from '../auth/access.service'
import { randomId } from '../../common/ids'
import { McpServerInput, McpReconnectInput, McpRegistryInput, type McpAuthInput } from '@lovbase/core/mcp'
import { auth, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { mcpFetch, safeMcpUrl, resolveMcpUrl } from './mcp-network'
export { safeMcpUrl } from './mcp-network'

type Credentials = { token?: string; headerName?: string; client?: OAuthClientInformationMixed; tokens?: OAuthTokens; expiresAt?: number; discovery?: OAuthDiscoveryState }
type OAuthSession = { state: string; server_id: string; project_id: string | null; return_path: string; verifier_enc: string | null }
export type McpConnectResult = { serverId: string; url?: string; error?: string }


export type McpRegistry = {
  id: string; url: string; displayName: string; state: string; lastSyncedAt: string | null; lastError: string | null
}
export type McpServer = {
  id: string; registryId: string | null; registryName: string | null; remoteId: string; name: string; description: string | null
  version: string | null; endpoint: string | null; transport: string; state: string; enabled: boolean
  source: 'direct' | 'registry'; authType: 'oauth' | 'token' | 'none'; accountEnabled: boolean; lastError: string | null
}
export type McpTool = {
  name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>
}

const asRecord = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
const hashArgs = async (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value ?? null))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('')
}

function pickEndpoint(server: Record<string, any>): { endpoint: string | null; transport: string } {
  const remotes = Array.isArray(server.remotes) ? server.remotes : Array.isArray(server.remote) ? server.remote : []
  for (const item of remotes) {
    const remote = asRecord(item)
    const endpoint = text(remote.url || remote.endpoint)
    if (endpoint && (text(remote.type, '').toLowerCase().includes('http') || !remote.type)) return { endpoint, transport: 'streamable_http' }
  }
  const endpoint = text(server.url || server.endpoint)
  return endpoint ? { endpoint, transport: 'streamable_http' } : { endpoint: null, transport: 'unsupported' }
}

type RegistryServerEntry = { remoteId: string; server: Record<string, any> }

function isLatestRegistryEntry(item: Record<string, any>): boolean {
  const metadata = asRecord(item._meta)
  return Object.values(metadata).some((value) => asRecord(value).isLatest === true)
}

/**
 * Registries can publish more than one record for the same server identifier
 * (for example, historical and latest versions). The database intentionally
 * keeps one row per registry/server identifier, so collapse duplicates before
 * writing the sync transaction.
 */
export function dedupeMcpRegistryEntries(entries: unknown[]): RegistryServerEntry[] {
  const unique = new Map<string, { item: Record<string, any>; server: Record<string, any> }>()
  for (const [index, value] of entries.entries()) {
    const item = asRecord(value)
    const server = asRecord(item.server || item)
    const remoteId = text(server.name || server.id, `server-${index}`).slice(0, 200)
    const previous = unique.get(remoteId)
    if (!previous) {
      unique.set(remoteId, { item, server })
      continue
    }
    const candidateLatest = isLatestRegistryEntry(item)
    const previousLatest = isLatestRegistryEntry(previous.item)
    const candidateHasEndpoint = !!pickEndpoint(server).endpoint
    const previousHasEndpoint = !!pickEndpoint(previous.server).endpoint
    if ((candidateLatest && !previousLatest) || (candidateLatest === previousLatest && candidateHasEndpoint && !previousHasEndpoint)) {
      unique.set(remoteId, { item, server })
    }
  }
  return [...unique.entries()].map(([remoteId, value]) => ({ remoteId, server: value.server })).slice(0, 200)
}

@Injectable()
export class McpService {
  private readonly log = new Logger(McpService.name)
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly schema: SchemaService,
    private readonly cfg: ConfigService,
    private readonly crypto: CryptoService,
  ) {}

  protected remoteFetch(timeout = this.cfg.env.MCP_TOOL_TIMEOUT_MS) { return mcpFetch(timeout, this.cfg.env.MCP_MAX_RESULT_BYTES) }
  protected async validateAuthorizationUrl(url: string, signal?: AbortSignal) { await resolveMcpUrl(url, signal) }

  get enabled() { return this.cfg.mcpEnabled }

  private requireEnabled() { if (!this.enabled) throw new DomainError('MCP is not enabled.') }

  async listRegistries(ctx: UserCtx): Promise<{ enabled: boolean; registries: McpRegistry[] }> {
    if (!this.enabled) return { enabled: false, registries: [] }
    await this.schema.ready()
    const result = await this.pool.query(`SELECT id, url, display_name, state, last_synced_at, last_error
      FROM public.lb_mcp_registries WHERE user_id = $1 ORDER BY created_at DESC`, [ctx.user.id])
    return { enabled: true, registries: result.rows.map((row) => ({
      id: row.id, url: row.url, displayName: row.display_name, state: row.state,
      lastSyncedAt: row.last_synced_at?.toISOString?.() ?? row.last_synced_at ?? null, lastError: row.last_error,
    })) }
  }

  private serverDto(row: any): McpServer {
    return { id: row.id, registryId: row.registry_id, registryName: row.registry_name ?? null, remoteId: row.remote_id,
      name: row.name, description: row.description, version: row.version, endpoint: row.endpoint, transport: row.transport,
      state: row.state, enabled: !!row.enabled, source: row.registry_id ? 'registry' : 'direct', authType: row.auth_type,
      accountEnabled: row.account_enabled, lastError: row.last_error }
  }

  async listServers(ctx: UserCtx, projectId?: string): Promise<{ enabled: boolean; servers: McpServer[] }> {
    if (!this.enabled) return { enabled: false, servers: [] }
    await this.schema.ready()
    if (projectId) await this.requireProject(ctx.user.id, projectId)
    const result = await this.pool.query(`SELECT s.*, r.display_name AS registry_name,
      EXISTS (SELECT 1 FROM public.lb_project_mcp_servers pc WHERE pc.server_id = s.id AND pc.enabled AND pc.project_id = $2) AS enabled
      FROM public.lb_mcp_servers s LEFT JOIN public.lb_mcp_registries r ON r.id = s.registry_id
      WHERE s.user_id = $1 ORDER BY s.name`, [ctx.user.id, projectId ?? null])
    return { enabled: true, servers: result.rows.map(row => this.serverDto(row)) }
  }

  async createRegistry(ctx: UserCtx, input: { url: string; displayName?: string; bearerToken?: string }) {
    this.requireEnabled()
    input = McpRegistryInput.parse(input)
    const url = safeMcpUrl(input.url)
    await this.schema.ready()
    const token = input.bearerToken?.trim() ? await this.crypto.encrypt(input.bearerToken.trim()) : null
    const id = 'mcp_' + randomId(20)
    try {
      await this.pool.query(`INSERT INTO public.lb_mcp_registries(id, user_id, url, display_name, bearer_token_enc)
        VALUES ($1, $2, $3, $4, $5)`, [id, ctx.user.id, url.href, input.displayName?.trim() || url.hostname, token])
      await this.audit({ userId: ctx.user.id, registryId: id, action: 'registry_created', state: 'succeeded' })
    } catch (error: any) {
      if (error?.code === '23505') throw new DomainError('This MCP registry is already connected.')
      throw error
    }
    try { await this.syncRegistry(ctx, id) }
    catch {
      const message = 'Could not sync MCP registry. Check its URL and credentials.'
      await this.pool.query(`UPDATE public.lb_mcp_registries SET state = 'error', last_error = $2, updated_at = now() WHERE id = $1`, [id, message.slice(0, 500)])
      throw new DomainError(message)
    }
    return this.listRegistries(ctx)
  }

  private async ownedRegistry(userId: string, id: string) {
    await this.schema.ready()
    const result = await this.pool.query('SELECT * FROM public.lb_mcp_registries WHERE id = $1 AND user_id = $2', [id, userId])
    if (!result.rows[0]) throw new NotFound('MCP registry not found.')
    return result.rows[0]
  }

  async syncRegistry(ctx: UserCtx, id: string) {
    this.requireEnabled()
    const registry = await this.ownedRegistry(ctx.user.id, id)
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = registry.bearer_token_enc ? await this.crypto.tryDecrypt(registry.bearer_token_enc) : null
    if (token) headers.authorization = `Bearer ${token}`
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.cfg.env.MCP_REGISTRY_TIMEOUT_MS)
    try {
      const response = await this.remoteFetch(this.cfg.env.MCP_REGISTRY_TIMEOUT_MS)(registry.url, { headers, signal: controller.signal })
      if (!response.ok) throw new DomainError(`MCP registry returned HTTP ${response.status}.`)
      const raw = await response.text()
      const body = asRecord(JSON.parse(raw))
      if (!Array.isArray(body.servers)) throw new DomainError('Invalid MCP registry response.')
      const entries = dedupeMcpRegistryEntries(body.servers)
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query("UPDATE public.lb_mcp_servers SET state = 'unavailable' WHERE registry_id = $1 AND NOT (remote_id = ANY($2::text[]))", [id, entries.map(entry => entry.remoteId)])
        for (const item of entries) {
          const rawServer = item.server
          const remoteId = item.remoteId
          const picked = pickEndpoint(rawServer)
          let endpoint: string | null = null
          let transport = picked.transport
          if (picked.endpoint) {
            try { endpoint = safeMcpUrl(picked.endpoint).href }
            catch { transport = 'unsupported' }
          }
          await client.query(`DELETE FROM public.lb_mcp_oauth_sessions WHERE server_id IN
            (SELECT id FROM public.lb_mcp_servers WHERE registry_id=$1 AND remote_id=$2 AND endpoint IS DISTINCT FROM $3)`, [id, remoteId, endpoint])
          await client.query(`INSERT INTO public.lb_mcp_servers(id, registry_id, remote_id, name, description, version, endpoint, transport, metadata, user_id, state, last_synced_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'available',now())
            ON CONFLICT (registry_id, remote_id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
              version = EXCLUDED.version, transport = EXCLUDED.transport, metadata = EXCLUDED.metadata,
              credentials_enc = CASE WHEN lb_mcp_servers.endpoint IS DISTINCT FROM EXCLUDED.endpoint THEN NULL ELSE lb_mcp_servers.credentials_enc END,
              state = CASE WHEN lb_mcp_servers.endpoint IS DISTINCT FROM EXCLUDED.endpoint AND lb_mcp_servers.auth_type <> 'none' THEN 'auth_required'
                WHEN lb_mcp_servers.state = 'unavailable' THEN 'available' ELSE lb_mcp_servers.state END,
              endpoint = EXCLUDED.endpoint, last_synced_at = now()`, [
            'mcs_' + randomId(20), id, remoteId, text(rawServer.title || rawServer.name, remoteId).slice(0, 200),
            text(rawServer.description).slice(0, 2000) || null, text(rawServer.version).slice(0, 100) || null,
            endpoint, transport, JSON.stringify(rawServer), ctx.user.id,
          ])
        }
        await client.query(`UPDATE public.lb_mcp_registries SET state = 'active', last_synced_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`, [id])
        await client.query('COMMIT')
        await this.audit({ userId: ctx.user.id, registryId: id, action: 'registry_sync', state: 'succeeded' })
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    } catch {
      const message = 'Could not sync MCP registry. Check its URL and credentials.'
      await this.pool.query(`UPDATE public.lb_mcp_registries SET state = 'error', last_error = $2, updated_at = now() WHERE id = $1`, [id, message.slice(0, 500)]).catch(() => {})
      await this.audit({ userId: ctx.user.id, registryId: id, action: 'registry_sync', state: 'failed', error: message })
      throw new DomainError(message)
    } finally { clearTimeout(timer) }
    return this.listRegistries(ctx)
  }

  async deleteRegistry(ctx: UserCtx, id: string) {
    this.requireEnabled(); await this.ownedRegistry(ctx.user.id, id)
    await this.pool.query('DELETE FROM public.lb_mcp_registries WHERE id = $1', [id])
    await this.audit({ userId: ctx.user.id, registryId: id, action: 'registry_deleted', state: 'succeeded' })
    return { ok: true }
  }

  private async requireProject(userId: string, projectId: string, db: Pick<pg.Pool, 'query'> = this.pool) {
    const result = await db.query('SELECT id FROM public.lb_projects WHERE id = $1 AND owner_id = $2', [projectId, userId])
    if (!result.rowCount) throw new NotFound('Project not found.')
  }

  private async lockedServer<T>(userId: string, serverId: string, work: (row: any, db: pg.PoolClient) => Promise<T>): Promise<T> {
    this.requireEnabled(); await this.schema.ready()
    const db = await this.pool.connect()
    try {
      await db.query("BEGIN")
      await db.query("SELECT set_config('lock_timeout', $1, true)", [String(this.cfg.env.MCP_TOOL_TIMEOUT_MS)])
      // Shared across web and worker processes, including refresh-token rotation.
      const result = await db.query('SELECT * FROM public.lb_mcp_servers WHERE id = $1 AND user_id = $2 FOR UPDATE', [serverId, userId])
      if (!result.rowCount) throw new NotFound('MCP server not found.')
      const value = await work(result.rows[0], db)
      await db.query('COMMIT')
      return value
    } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
  }

  private credentials(input: McpAuthInput): Credentials {
    if (input.type === 'token') return { token: input.token, headerName: input.headerName }
    if (input.type === 'oauth' && input.clientId) return { client: { client_id: input.clientId, ...(input.clientSecret ? { client_secret: input.clientSecret } : {}) } }
    return {}
  }

  async createServer(ctx: UserCtx, raw: unknown): Promise<McpConnectResult> {
    this.requireEnabled(); await this.schema.ready()
    const input = McpServerInput.parse(raw)
    const url = safeMcpUrl(input.url).href
    if (input.projectId) await this.requireProject(ctx.user.id, input.projectId)
    const id = 'mcs_' + randomId(20)
    try {
      await this.pool.query(`INSERT INTO public.lb_mcp_servers(id,user_id,remote_id,name,endpoint,auth_type,credentials_enc,state)
        VALUES ($1,$2,$1,$3,$4,$5,$6,'pending')`, [id, ctx.user.id, input.name, url, input.auth.type, await this.crypto.encrypt(JSON.stringify(this.credentials(input.auth)))])
    } catch (error: any) {
      if (error?.code === '23505') throw new DomainError('This MCP server is already connected. Reconnect it from the list.')
      throw error
    }
    await this.audit({ userId: ctx.user.id, serverId: id, action: 'server_created', state: 'pending' })
    return this.reconnectServer(ctx, { serverId: id, projectId: input.projectId, returnTo: input.returnTo })
  }

  get clientMetadata() {
    return { client_name: 'Lovbase', redirect_uris: [new URL('/api/integrations/mcp/callback', this.cfg.env.BETTER_AUTH_URL).href],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
  }

  get clientMetadataDocument() {
    return { client_id: new URL('/api/integrations/mcp/client-metadata', this.cfg.env.BETTER_AUTH_URL).href, ...this.clientMetadata }
  }

  private async newOAuthSession(db: pg.PoolClient, userId: string, serverId: string, projectId?: string, returnTo = 'dialog'): Promise<OAuthSession> {
    const state = randomId(48)
    const returnPath = (projectId ? `/projects/${encodeURIComponent(projectId)}` : '/settings') + `#view=${returnTo}`
    await db.query('DELETE FROM public.lb_mcp_oauth_sessions WHERE server_id = $1 OR expires_at < now()', [serverId])
    await db.query(`INSERT INTO public.lb_mcp_oauth_sessions(state,user_id,server_id,project_id,return_path,expires_at)
      VALUES ($1,$2,$3,$4,$5,now()+interval '10 minutes')`, [state, userId, serverId, projectId ?? null, returnPath])
    return { state, server_id: serverId, project_id: projectId ?? null, return_path: returnPath, verifier_enc: null }
  }

  async reconnectServer(ctx: UserCtx, raw: unknown): Promise<McpConnectResult> {
    const input = McpReconnectInput.parse(raw)
    if (input.projectId) { await this.schema.ready(); await this.requireProject(ctx.user.id, input.projectId) }
    const outcome = await this.lockedServer(ctx.user.id, input.serverId, async (row, db) => {
      if (input.url && safeMcpUrl(input.url).href !== row.endpoint || input.name && input.name !== row.name) {
        if (row.registry_id) throw new DomainError('Registry server addresses are managed by their registry.')
        const endpoint = input.url ? safeMcpUrl(input.url).href : row.endpoint
        if (endpoint !== row.endpoint) {
          row.credentials_enc = null
          await db.query('DELETE FROM public.lb_mcp_oauth_sessions WHERE server_id=$1', [row.id])
        }
        row.endpoint = endpoint; row.name = input.name ?? row.name
        await db.query('UPDATE public.lb_mcp_servers SET endpoint=$2,name=$3,credentials_enc=$4 WHERE id=$1', [row.id, row.endpoint, row.name, row.credentials_enc])
      }
      if (input.auth) {
        row.auth_type = input.auth.type
        row.credentials_enc = await this.crypto.encrypt(JSON.stringify(this.credentials(input.auth)))
        await db.query('UPDATE public.lb_mcp_servers SET auth_type=$2, credentials_enc=$3 WHERE id=$1', [row.id, row.auth_type, row.credentials_enc])
      }
      // A failed connection must not activate a previously suspended account connection.
      const session = row.auth_type === 'oauth' ? await this.newOAuthSession(db, ctx.user.id, row.id, input.projectId, input.returnTo) : undefined
      const result = await this.session(row, db, { interactive: true, session })
      if (!result.error && !result.url) {
        await db.query('UPDATE public.lb_mcp_servers SET account_enabled=true WHERE id=$1', [row.id])
        if (session) await db.query('DELETE FROM public.lb_mcp_oauth_sessions WHERE state=$1', [session.state])
        if (input.projectId) {
          try { await this.enableProject(db, ctx.user.id, input.projectId, row.id) }
          catch (error) {
            if (!(error instanceof DomainError)) throw error
            return { serverId: row.id as string, error: error.message, url: undefined }
          }
        }
      }
      return { serverId: row.id as string, error: result.error, url: result.url }
    })
    await this.audit({ userId: ctx.user.id, serverId: input.serverId, action: 'server_connect', state: outcome.error ? 'failed' : outcome.url ? 'pending' : 'succeeded' })
    return outcome
  }

  async completeOAuth(ctx: UserCtx, input: { state: string; code?: string; error?: string }) {
    this.requireEnabled(); await this.schema.ready()
    // Consume before exchanging the code; even an unsuccessful exchange cannot be replayed.
    const result = await this.pool.query(`UPDATE public.lb_mcp_oauth_sessions SET consumed_at=now()
      WHERE state=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING *`, [input.state, ctx.user.id])
    const session: OAuthSession | undefined = result.rows[0]
    if (!session) throw new DomainError('This authorization link is invalid or expired. Connect again.')
    let status = 'failed'
    try {
      status = await this.lockedServer(ctx.user.id, session.server_id, async (row, db) => {
        const pending = await db.query('SELECT state FROM public.lb_mcp_oauth_sessions WHERE state=$1 AND server_id=$2', [session.state, row.id])
        if (!pending.rowCount || row.auth_type !== 'oauth') return 'failed'
        if (input.error || !input.code) {
          await db.query("UPDATE public.lb_mcp_servers SET state='auth_required', last_error='Authorization was cancelled. Connect again.' WHERE id=$1", [row.id])
          return 'cancelled'
        }
        if (session.project_id) await this.requireProject(ctx.user.id, session.project_id, db)
        const connected = await this.session(row, db, { session, code: input.code })
        if (connected.error) return 'failed'
        await db.query('UPDATE public.lb_mcp_servers SET account_enabled=true WHERE id=$1', [row.id])
        if (session.project_id) {
          try { await this.enableProject(db, ctx.user.id, session.project_id, row.id) }
          catch (error) {
            if (!(error instanceof DomainError)) throw error
            return 'project_limit'
          }
        }
        return 'connected'
      })
    } catch { status = 'failed' }
    await this.pool.query('UPDATE public.lb_mcp_oauth_sessions SET verifier_enc=NULL WHERE state=$1', [input.state])
    await this.audit({ userId: ctx.user.id, serverId: session.server_id, action: 'oauth_callback', state: status })
    return `${session.return_path}&mcp=${status}`
  }

  /** One bounded connection, with credentials never returned to the Agent or browser. */
  private async session(row: any, db: pg.PoolClient, options: { interactive?: boolean; session?: OAuthSession; code?: string; tool?: { name: string; args: Record<string, unknown> }; allowed?: string[] | null } = {}) {
    const client = new Client({ name: 'lovbase', version: '1.0.0' }, { capabilities: {} })
    const timeout = this.cfg.env.MCP_TOOL_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    let authorizationUrl: string | undefined
    let credentials: Credentials = {}
    let authRequired = false
    const save = async () => {
      controller.signal.throwIfAborted()
      await db.query('UPDATE public.lb_mcp_servers SET credentials_enc=$2 WHERE id=$1', [row.id, await this.crypto.encrypt(JSON.stringify(credentials))])
    }
    try {
      if (!row.endpoint || row.transport !== 'streamable_http') throw new DomainError('Unsupported MCP transport.')
      if (row.credentials_enc) credentials = JSON.parse(await this.crypto.decrypt(row.credentials_enc))
      const endpoint = safeMcpUrl(row.endpoint)
      const network = this.remoteFetch(timeout)
      const fetcher: typeof network = (input, init) => network(input, { ...init, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) })
      const provider: OAuthClientProvider | undefined = row.auth_type !== 'oauth' ? undefined : {
        redirectUrl: this.clientMetadata.redirect_uris[0],
        clientMetadata: this.clientMetadata,
        clientMetadataUrl: this.cfg.env.BETTER_AUTH_URL.startsWith('https:') ? new URL('/api/integrations/mcp/client-metadata', this.cfg.env.BETTER_AUTH_URL).href : undefined,
        state: () => { if (!options.session) { authRequired = true; throw new UnauthorizedError() }; return options.session.state },
        clientInformation: () => credentials.client,
        saveClientInformation: async value => { credentials.client = value; await save() },
        tokens: () => credentials.tokens,
        saveTokens: async value => {
          credentials.tokens = { ...value, refresh_token: value.refresh_token ?? credentials.tokens?.refresh_token }
          credentials.expiresAt = value.expires_in ? Date.now() + value.expires_in * 1000 : undefined
          await save()
        },
        redirectToAuthorization: async url => {
          authRequired = true
          if (!options.interactive) throw new UnauthorizedError()
          await this.validateAuthorizationUrl(url.href, controller.signal)
          authorizationUrl = url.href
        },
        saveCodeVerifier: async verifier => {
          if (!options.session || !options.interactive) { authRequired = true; throw new UnauthorizedError() }
          controller.signal.throwIfAborted()
          options.session.verifier_enc = await this.crypto.encrypt(verifier)
          await db.query('UPDATE public.lb_mcp_oauth_sessions SET verifier_enc=$2 WHERE state=$1', [options.session.state, options.session.verifier_enc])
        },
        codeVerifier: async () => {
          if (!options.session?.verifier_enc) throw new UnauthorizedError()
          return this.crypto.decrypt(options.session.verifier_enc)
        },
        discoveryState: () => credentials.discovery,
        saveDiscoveryState: async value => { credentials.discovery = value; await save() },
        invalidateCredentials: async scope => {
          if (scope === 'all' || scope === 'tokens') { delete credentials.tokens; delete credentials.expiresAt }
          if (scope === 'all' || scope === 'client') delete credentials.client
          if (scope === 'all' || scope === 'discovery') delete credentials.discovery
          await save()
        },
      }
      const headers: Record<string, string> = {}
      if (row.auth_type === 'token') {
        if (!credentials.token) { authRequired = true; throw new UnauthorizedError() }
        headers[credentials.headerName ?? 'Authorization'] = credentials.headerName ? credentials.token : `Bearer ${credentials.token}`
      }
      const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider, fetch: fetcher, requestInit: { headers, redirect: 'error' }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 } })
      if (options.code) await transport.finishAuth(options.code)
      else if (provider && credentials.expiresAt && credentials.expiresAt < Date.now() + 30_000) {
        await auth(provider, { serverUrl: endpoint, fetchFn: fetcher })
        if (authorizationUrl) throw new UnauthorizedError()
      }
      await client.connect(transport, { timeout })
      const tools: McpTool[] = []
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const listed = await client.listTools(cursor ? { cursor } : {}, { timeout })
        tools.push(...listed.tools.filter(tool => !options.allowed || options.allowed.includes(tool.name)).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations })))
        cursor = listed.nextCursor
        if (tools.length > 1000 || cursor && seen.has(cursor)) throw new DomainError('Too many MCP tools.')
        if (cursor) seen.add(cursor)
      } while (cursor)
      let result: unknown
      if (options.tool) {
        if (!tools.some(tool => tool.name === options.tool!.name)) throw new DomainError('MCP tool is no longer available.')
        result = await client.callTool({ name: options.tool.name, arguments: options.tool.args }, undefined, { timeout })
        if (Buffer.byteLength(JSON.stringify(result)) > this.cfg.env.MCP_MAX_RESULT_BYTES) throw new DomainError('MCP result is too large.')
      }
      await db.query("UPDATE public.lb_mcp_servers SET state='active',last_error=NULL,last_synced_at=now() WHERE id=$1", [row.id])
      return { tools, result, url: undefined, error: undefined }
    } catch (error) {
      // Never persist or expose remote error bodies, URLs, tokens, or SDK error messages.
      const needsAuth = authRequired || error instanceof UnauthorizedError
      const message = needsAuth ? 'Authorization required. Reconnect this MCP server.' : controller.signal.aborted ? 'MCP request timed out.' : 'Could not connect to MCP server or run its tool. Check the URL, authentication and server availability.'
      await db.query('UPDATE public.lb_mcp_servers SET state=$2,last_error=$3 WHERE id=$1', [row.id, authorizationUrl ? 'pending' : needsAuth ? 'auth_required' : 'error', authorizationUrl ? null : message])
      return { tools: [] as McpTool[], result: undefined, url: authorizationUrl, error: authorizationUrl ? undefined : message }
    } finally {
      controller.abort(); clearTimeout(timer)
      await client.close().catch(() => {})
    }
  }

  private async enableProject(db: pg.PoolClient, userId: string, projectId: string, serverId: string) {
    const owned = await db.query('SELECT id FROM public.lb_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE', [projectId, userId])
    if (!owned.rowCount) throw new NotFound('Project not found.')
    const count = await db.query('SELECT count(*)::int AS count FROM public.lb_project_mcp_servers WHERE project_id=$1 AND enabled AND server_id<>$2', [projectId, serverId])
    if (count.rows[0].count >= this.cfg.env.MCP_MAX_SERVERS_PER_PROJECT) throw new DomainError('This project has reached its MCP server limit.')
    await db.query(`INSERT INTO public.lb_project_mcp_servers(project_id,server_id,enabled) VALUES($1,$2,true)
      ON CONFLICT(project_id,server_id) DO UPDATE SET enabled=true`, [projectId, serverId])
  }

  async setServerEnabled(ctx: ProjectCtx, serverId: string, enabled: boolean) {
    await this.lockedServer(ctx.user.id, serverId, async (row, db) => {
      await this.requireProject(ctx.user.id, ctx.project.id, db)
      if (enabled) {
        if (!row.account_enabled || !row.endpoint || row.transport !== 'streamable_http' || !['active', 'available'].includes(row.state)) throw new DomainError('Connect this MCP server before enabling it.')
        await this.enableProject(db, ctx.user.id, ctx.project.id, serverId)
      } else await db.query('UPDATE public.lb_project_mcp_servers SET enabled=false WHERE project_id=$1 AND server_id=$2', [ctx.project.id, serverId])
    })
    await this.audit({ userId: ctx.user.id, projectId: ctx.project.id, serverId, action: enabled ? 'server_enabled' : 'server_disabled', state: 'succeeded' })
    return this.listServers(ctx, ctx.project.id)
  }

  async setAccountEnabled(ctx: UserCtx, serverId: string, enabled: boolean) {
    await this.lockedServer(ctx.user.id, serverId, async (row, db) => {
      if (enabled && !['active', 'available'].includes(row.state)) throw new DomainError('Reconnect this MCP server first.')
      await db.query('UPDATE public.lb_mcp_servers SET account_enabled=$2 WHERE id=$1', [serverId, enabled])
      if (!enabled) await db.query('DELETE FROM public.lb_mcp_oauth_sessions WHERE server_id=$1', [serverId])
    })
    await this.audit({ userId: ctx.user.id, serverId, action: 'account_enabled', state: String(enabled) })
    return { ok: true }
  }

  async deleteServer(ctx: UserCtx, serverId: string) {
    await this.lockedServer(ctx.user.id, serverId, async (_row, db) => { await db.query('DELETE FROM public.lb_mcp_servers WHERE id=$1', [serverId]) })
    await this.audit({ userId: ctx.user.id, serverId, action: 'server_deleted', state: 'succeeded' })
    return { ok: true }
  }

  private async projectAccess(db: pg.PoolClient, userId: string, projectId: string, row: any) {
    const result = await db.query(`SELECT pc.allowed_tools FROM public.lb_project_mcp_servers pc JOIN public.lb_projects p ON p.id=pc.project_id
      WHERE p.id=$1 AND p.owner_id=$2 AND pc.server_id=$3 AND pc.enabled`, [projectId, userId, row.id])
    if (!result.rowCount || !row.account_enabled || row.state === 'unavailable' || row.state === 'auth_required' || row.state === 'pending') throw new NotFound('MCP server is not enabled for this project.')
    return result.rows[0].allowed_tools as string[] | null
  }

  async toolsForProject(userId: string, projectId: string): Promise<Array<McpServer & { tools: McpTool[] }>> {
    if (!this.enabled) return []
    const state = await this.listServers({ user: { id: userId } } as UserCtx, projectId)
    const out: Array<McpServer & { tools: McpTool[] }> = []
    for (const server of state.servers.filter(s => s.enabled && s.accountEnabled)) {
      try {
        const result = await this.lockedServer(userId, server.id, async (row, db) => {
          const allowed = await this.projectAccess(db, userId, projectId, row)
          return this.session(row, db, { allowed })
        })
        if (!result.error) out.push({ ...server, tools: result.tools })
      } catch { this.log.warn(`MCP tools unavailable for ${server.id}`) }
    }
    return out
  }

  async callTool(userId: string, projectId: string, serverId: string, toolName: string, args: Record<string, unknown>) {
    const started = Date.now()
    const result = await this.lockedServer(userId, serverId, async (row, db) => {
      const allowed = await this.projectAccess(db, userId, projectId, row)
      return this.session(row, db, { allowed, tool: { name: toolName, args } })
    })
    await this.audit({ userId, projectId, serverId, toolName, action: 'tool_call', state: result.error ? 'failed' : 'succeeded', duration: Date.now() - started })
    if (result.error) throw new DomainError(result.error)
    return result.result
  }

  async createApproval(userId: string, projectId: string, runId: string | undefined, serverId: string, toolName: string, args: Record<string, unknown>, toolCallId?: string) {
    await this.schema.ready()
    await this.pool.query(`UPDATE public.lb_mcp_approvals SET state = 'expired', decided_at = now()
      WHERE user_id = $1 AND project_id = $2 AND state = 'pending' AND expires_at <= now()`, [userId, projectId])
    const id = 'mca_' + randomId(20)
    const argsHash = await hashArgs(args)
    const existing = toolCallId ? await this.pool.query(`SELECT id FROM public.lb_mcp_approvals
      WHERE user_id = $1 AND project_id = $2 AND tool_call_id = $3 AND args_hash = $4
        AND state IN ('pending', 'approved') AND executed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`, [userId, projectId, toolCallId, argsHash]) : { rows: [] }
    if (existing.rows[0]) return existing.rows[0].id as string
    await this.pool.query(`INSERT INTO public.lb_mcp_approvals(id,user_id,project_id,run_id,tool_call_id,server_id,tool_name,args,args_hash,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '10 minutes')`, [id, userId, projectId, runId ?? null, toolCallId ?? null, serverId, toolName, JSON.stringify(args), argsHash])
    return id
  }

  async consumeApprovedInvocation(userId: string, projectId: string, serverId: string, toolName: string, args: Record<string, unknown>, toolCallId?: string) {
    await this.schema.ready()
    await this.pool.query(`UPDATE public.lb_mcp_approvals SET state = 'expired', decided_at = now()
      WHERE user_id = $1 AND project_id = $2 AND state = 'approved' AND expires_at <= now()`, [userId, projectId])
    const argsHash = await hashArgs(args)
    const result = await this.pool.query(`UPDATE public.lb_mcp_approvals SET executed_at = now()
      WHERE id = (SELECT id FROM public.lb_mcp_approvals
        WHERE user_id = $1 AND project_id = $2 AND server_id = $3 AND tool_name = $4 AND args_hash = $5
          AND ($6::text IS NULL OR tool_call_id = $6) AND state = 'approved' AND expires_at > now() AND executed_at IS NULL
        ORDER BY created_at DESC FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id`, [userId, projectId, serverId, toolName, argsHash, toolCallId ?? null])
    if (!result.rowCount) throw new DomainError('MCP approval is missing, expired, or already used.')
    await this.audit({ userId, projectId, serverId, toolName, action: 'approval_execute', state: 'approved' })
  }

  /** Reconcile approval responses from the UI transcript before a replayed turn executes. */
  async reconcileApprovalResponses(userId: string, projectId: string, messages: unknown) {
    if (!this.enabled) return
    await this.schema.ready()
    await this.pool.query(`UPDATE public.lb_mcp_approvals SET state = 'expired', decided_at = now()
      WHERE user_id = $1 AND project_id = $2 AND state = 'pending' AND expires_at <= now()`, [userId, projectId])
    if (!Array.isArray(messages)) return
    const approvalToToolCall = new Map<string, string>()
    const responses: Array<{ approvalId: string; approved: boolean }> = []
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) { for (const item of value) visit(item); return }
      const item = value as Record<string, unknown>
      const approval = item.approval as Record<string, unknown> | undefined
      const approvalId = typeof item.approvalId === 'string' ? item.approvalId : typeof approval?.id === 'string' ? approval.id : null
      const toolCallId = typeof item.toolCallId === 'string' ? item.toolCallId : null
      if (approvalId && toolCallId) approvalToToolCall.set(approvalId, toolCallId)
      if (item.type === 'tool-approval-response' && approvalId && typeof item.approved === 'boolean') responses.push({ approvalId, approved: item.approved })
      if (approvalId && typeof approval?.approved === 'boolean') responses.push({ approvalId, approved: approval.approved })
      for (const child of Object.values(item)) visit(child)
    }
    visit(messages)
    for (const response of responses) {
      const toolCallId = approvalToToolCall.get(response.approvalId)
      if (!toolCallId) continue
      const updated = await this.pool.query(`UPDATE public.lb_mcp_approvals SET state = $4, decided_at = now()
        WHERE user_id = $1 AND project_id = $2 AND tool_call_id = $3 AND state = 'pending' AND expires_at > now()`, [userId, projectId, toolCallId, response.approved ? 'approved' : 'denied'])
      if (updated.rowCount && !response.approved) {
        const approval = await this.pool.query(`SELECT server_id, tool_name FROM public.lb_mcp_approvals WHERE user_id = $1 AND project_id = $2 AND tool_call_id = $3 ORDER BY created_at DESC LIMIT 1`, [userId, projectId, toolCallId])
        if (approval.rows[0]) await this.audit({ userId, projectId, serverId: approval.rows[0].server_id, toolName: approval.rows[0].tool_name, action: 'approval', state: 'denied' })
      }
    }
  }

  private async audit(input: { userId: string; projectId?: string; serverId?: string; registryId?: string; toolName?: string; action: string; state: string; duration?: number; resultBytes?: number; error?: string }) {
    await this.pool.query(`INSERT INTO public.lb_mcp_audit(user_id,project_id,server_id,registry_id,tool_name,action,state,duration_ms,result_bytes,error)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [input.userId, input.projectId, input.serverId ?? null, input.registryId ?? null, input.toolName ?? null, input.action, input.state, input.duration ?? null, input.resultBytes ?? null, input.error?.slice(0, 500) ?? null]).catch(() => {})
  }

}
