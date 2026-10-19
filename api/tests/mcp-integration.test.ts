import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { plugin } from 'bun'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import type pg from 'pg'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ConfigService } from '../src/config/config.service'
import { SchemaService } from '../src/database/schema.service'
import { CryptoService } from '../src/modules/crypto/crypto.service'
import { McpService, safeMcpUrl } from '../src/modules/integrations/mcp.service'
import { integrationSchema } from '../src/modules/integrations/schema'
import { McpAuth } from '@lovbase/core/mcp'
import type { ProjectCtx } from '../src/modules/auth/access.service'

plugin({ name: 'mcp-agent-markdown', setup(build) {
  build.onLoad({ filter: /\/agent\/skills\/.*\.md$/ }, args => ({ exports: { default: readFileSync(args.path, 'utf8') }, loader: 'object' }))
} })
const { AgentService } = await import('../src/modules/agent/agent.service')

const db = new PGlite()
let tail = Promise.resolve()
async function query(sql: string, params?: unknown[]) { const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows || r.rows.length } }
const pool = { query, connect: async () => {
  const before = tail; let release!: () => void
  tail = new Promise(resolve => { release = resolve }); await before
  return { query, release }
} } as unknown as pg.Pool
const schema = new SchemaService(pool)
const cfg = ConfigService.of({ MCP_ENABLED: 'true', BETTER_AUTH_URL: 'https://lovbase.example', MCP_TOOL_TIMEOUT_MS: 1000, MCP_MAX_SERVERS_PER_PROJECT: 2 })
const cryptoService = new CryptoService(cfg)

/** Actual SDK client + OAuth engine against a deterministic remote protocol, without external credentials. */
class Remote {
  mode: 'none' | 'token' | 'oauth' = 'none'
  customHeader = false
  fail = false
  timeout = false
  refreshFails = false
  metadataClient = false
  refreshes = 0
  registrations = 0
  tokenExchanges = 0
  toolCalls = 0
  accessToken = 'access-1'
  requests: Request[] = []
  entries: unknown[] = [{ server: { name: 'example/tools', remotes: [{ type: 'streamable-http', url: 'https://server.example.test/mcp' }] } }]
  json(value: unknown, status = 200, headers: Record<string, string> = {}) { return Response.json(value, { status, headers }) }
  fetch: FetchLike = async (input, init) => {
    const req = new Request(input, init)
    this.requests.push(req.clone())
    const url = new URL(req.url)
    if (url.hostname === 'registry.example.test') return this.json({ servers: this.entries })
    if (url.pathname.includes('oauth-protected-resource')) return this.json({ resource: 'https://server.example.test/mcp', authorization_servers: ['https://auth.example.test'], scopes_supported: ['tools'] })
    if (url.pathname.includes('well-known')) return this.json({ issuer: 'https://auth.example.test', authorization_endpoint: 'https://auth.example.test/authorize', token_endpoint: 'https://auth.example.test/token', registration_endpoint: 'https://auth.example.test/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post'], client_id_metadata_document_supported: this.metadataClient })
    if (url.pathname === '/register') { this.registrations++; return this.json({ ...(await req.json()), client_id: 'registered-client' }, 201) }
    if (url.pathname === '/token') {
      const body = new URLSearchParams(await req.text())
      if (body.get('grant_type') === 'refresh_token') {
        this.refreshes++
        if (this.refreshFails) return this.json({ error: 'invalid_grant' }, 400)
        this.accessToken = `access-${this.refreshes + 1}`
      } else {
        this.tokenExchanges++
        if (!body.get('code_verifier')) return this.json({ error: 'invalid_request' }, 400)
      }
      return this.json({ access_token: this.accessToken, token_type: 'Bearer', refresh_token: 'refresh-secret', expires_in: 3600 })
    }
    if (this.timeout) return new Promise((_resolve, reject) => req.signal.addEventListener('abort', () => reject(new Error('remote timeout')), { once: true }))
    if (this.fail) return this.json({ error: 'SECRET-REMOTE-ERROR' }, 500)
    const expected = this.mode === 'oauth' ? `Bearer ${this.accessToken}` : this.customHeader ? 'api-secret' : 'Bearer api-secret'
    if (this.mode !== 'none' && req.headers.get(this.customHeader && this.mode === 'token' ? 'x-api-key' : 'authorization') !== expected)
      return this.json({}, 401, { 'WWW-Authenticate': 'Bearer resource_metadata="https://server.example.test/.well-known/oauth-protected-resource"' })
    if (req.method === 'GET') return new Response(null, { status: 405 })
    if (req.method === 'DELETE') return new Response(null, { status: 200 })
    const body = await req.json() as any
    if (!('id' in body)) return new Response(null, { status: 202 })
    let result: unknown
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
    else if (body.method === 'tools/list') result = { tools: [
      { name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'write', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
    ] }
    else if (body.method === 'tools/call') { this.toolCalls++; result = { content: [{ type: 'text', text: `tool:${body.params.name}` }] } }
    else result = {}
    return this.json({ jsonrpc: '2.0', id: body.id, result })
  }
}
class TestMcp extends McpService {
  constructor(readonly remote: Remote) { super(pool, schema, cfg, cryptoService) }
  protected override remoteFetch() { return this.remote.fetch }
  protected override async validateAuthorizationUrl(url: string) { safeMcpUrl(url) }
}
let sequence = 0
async function fixture(mode: Remote['mode'] = 'none') {
  const id = `mcptest${++sequence}`
  await query('INSERT INTO public."user"(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$2,now(),now())', [id, `${id}@test.invalid`])
  await query('INSERT INTO public.lb_projects(id,owner_id,ir) VALUES($1,$1,$2)', [id, '{"entities":[]}'])
  const ctx = { user: { id }, project: { id, owner_id: id } } as ProjectCtx
  const remote = new Remote(); remote.mode = mode
  return { ctx, remote, service: new TestMcp(remote) }
}
const input = { name: 'Example tools', url: 'https://server.example.test/mcp', auth: { type: 'none' } }
async function expireToken(serverId: string) {
  const row = (await query('SELECT credentials_enc FROM public.lb_mcp_servers WHERE id=$1', [serverId])).rows[0] as any
  const data = JSON.parse(await cryptoService.decrypt(row.credentials_enc)); data.expiresAt = 1
  await query('UPDATE public.lb_mcp_servers SET credentials_enc=$2 WHERE id=$1', [serverId, await cryptoService.encrypt(JSON.stringify(data))])
}
beforeAll(async () => { await schema.ready() }, 30_000)
afterAll(async () => { await db.close() })

describe('MCP direct server lifecycle', () => {
  test('connects, persists, discovers and calls tools; enables only the originating project', async () => {
    const { ctx, service, remote } = await fixture()
    const result = await service.createServer(ctx, { ...input, projectId: ctx.project.id })
    expect(result.error).toBeUndefined()
    const servers = await service.listServers(ctx, ctx.project.id)
    expect(servers.servers[0]).toMatchObject({ source: 'direct', authType: 'none', state: 'active', enabled: true, accountEnabled: true })
    expect((await new TestMcp(remote).toolsForProject(ctx.user.id, ctx.project.id))[0].tools).toHaveLength(2)
    expect(await service.callTool(ctx.user.id, ctx.project.id, result.serverId, 'read', {})).toMatchObject({ content: [{ text: 'tool:read' }] })
    await expect(service.createServer(ctx, input)).rejects.toThrow('already connected')
    await service.setServerEnabled(ctx, result.serverId, false)
    await expect(service.callTool(ctx.user.id, ctx.project.id, result.serverId, 'read', {})).rejects.toThrow()
    await service.setServerEnabled(ctx, result.serverId, true)
    await service.setAccountEnabled(ctx, result.serverId, false)
    expect(await service.toolsForProject(ctx.user.id, ctx.project.id)).toHaveLength(0)
    await expect(service.callTool(ctx.user.id, ctx.project.id, result.serverId, 'read', {})).rejects.toThrow()
    await service.setAccountEnabled(ctx, result.serverId, true)
    await service.deleteServer(ctx, result.serverId)
    expect((await service.listServers(ctx)).servers).toHaveLength(0)
    expect((await query('SELECT * FROM public.lb_project_mcp_servers WHERE server_id=$1', [result.serverId])).rowCount).toBe(0)
  })

  test('token and API key credentials are encrypted and never included in DTOs', async () => {
    for (const customHeader of [false, true]) {
      const { ctx, service, remote } = await fixture('token'); remote.customHeader = customHeader
      const result = await service.createServer(ctx, { ...input, auth: { type: 'token', token: 'api-secret', headerName: customHeader ? 'x-api-key' : undefined }, projectId: ctx.project.id })
      expect(result.error).toBeUndefined()
      const row = (await query('SELECT credentials_enc FROM public.lb_mcp_servers WHERE id=$1', [result.serverId])).rows[0] as any
      expect(row.credentials_enc).not.toContain('api-secret')
      expect(await cryptoService.decrypt(row.credentials_enc)).toContain('api-secret')
      expect(JSON.stringify(await service.listServers(ctx))).not.toContain('api-secret')
      expect(JSON.stringify(await service.toolsForProject(ctx.user.id, ctx.project.id))).not.toContain('api-secret')
    }
  })

  test('rejects cross-account access, project hijacking and reserved custom headers', async () => {
    const a = await fixture(), b = await fixture()
    const result = await a.service.createServer(a.ctx, input)
    await expect(a.service.reconnectServer(b.ctx, { serverId: result.serverId })).rejects.toThrow()
    await expect(a.service.deleteServer(b.ctx, result.serverId)).rejects.toThrow()
    await expect(a.service.setAccountEnabled(b.ctx, result.serverId, false)).rejects.toThrow()
    await expect(a.service.setServerEnabled(b.ctx, result.serverId, true)).rejects.toThrow()
    await expect(a.service.createServer(a.ctx, { ...input, projectId: b.ctx.project.id })).rejects.toThrow()
    await expect(a.service.listServers(a.ctx, b.ctx.project.id)).rejects.toThrow()
    for (const headerName of ['Host', 'Cookie', 'Content-Length', 'Mcp-Session-Id', 'Proxy-Authorization', 'x-api-key\r\nInjected'])
      expect(McpAuth.safeParse({ type: 'token', token: 'secret', headerName }).success).toBe(false)
  })

  test('failed connections stay disabled for the project and redact remote errors; retries reuse the row', async () => {
    const { ctx, service, remote } = await fixture(); remote.fail = true
    const result = await service.createServer(ctx, { ...input, projectId: ctx.project.id })
    expect(result.error).toBeDefined()
    expect(JSON.stringify(await service.listServers(ctx, ctx.project.id))).not.toContain('SECRET-REMOTE-ERROR')
    expect((await service.listServers(ctx, ctx.project.id)).servers[0].enabled).toBe(false)
    remote.fail = false
    expect((await service.reconnectServer(ctx, { serverId: result.serverId, projectId: ctx.project.id })).error).toBeUndefined()
    expect((await service.listServers(ctx, ctx.project.id)).servers[0].enabled).toBe(true)
  })

  test('timeouts abort requests and persist a retryable state', async () => {
    const { ctx, service, remote } = await fixture(); remote.timeout = true
    const result = await service.createServer(ctx, input)
    expect(result.error).toContain('timed out')
    remote.timeout = false
    expect((await service.reconnectServer(ctx, { serverId: result.serverId })).error).toBeUndefined()
  })

  test('project limits are idempotent and per-project', async () => {
    const { ctx, service } = await fixture()
    const first = await service.createServer(ctx, { ...input, projectId: ctx.project.id })
    await service.createServer(ctx, { ...input, url: input.url + '/2', projectId: ctx.project.id })
    await expect(service.setServerEnabled(ctx, first.serverId, true)).resolves.toBeDefined()
    const third = await service.createServer(ctx, { ...input, url: input.url + '/3', projectId: ctx.project.id })
    expect(third.error).toContain('limit')
    expect((await service.listServers(ctx, ctx.project.id)).servers.find(server => server.id === third.serverId)).toMatchObject({ state: 'active', enabled: false })
    await expect(service.setServerEnabled(ctx, third.serverId, true)).rejects.toThrow('limit')
  })
})

describe('MCP OAuth', () => {
  test('dynamic registration, PKCE and callback survive restart; refresh is serialized', async () => {
    const { ctx, service, remote } = await fixture('oauth')
    const result = await service.createServer(ctx, { ...input, auth: { type: 'oauth' }, projectId: ctx.project.id })
    expect(result.error).toBeUndefined(); expect(result.url).toBeDefined()
    const authorize = new URL(result.url!)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://lovbase.example/api/integrations/mcp/callback')
    expect(remote.registrations).toBe(1)
    const state = authorize.searchParams.get('state')!
    const restored = new TestMcp(remote)
    const redirect = await restored.completeOAuth(ctx, { state, code: 'test-code' })
    expect(redirect).toContain('mcp=connected')
    expect((await restored.listServers(ctx, ctx.project.id)).servers[0].enabled).toBe(true)
    await expect(restored.completeOAuth(ctx, { state, code: 'test-code' })).rejects.toThrow('invalid or expired')
    await expireToken(result.serverId)
    const replies = await Promise.all([restored.callTool(ctx.user.id, ctx.project.id, result.serverId, 'read', {}), restored.callTool(ctx.user.id, ctx.project.id, result.serverId, 'read', {})])
    expect(replies).toHaveLength(2); expect(remote.refreshes).toBe(1)
    expect(JSON.stringify(await restored.listServers(ctx))).not.toContain('access-')
  })

  test('pre-registered and metadata-document clients do not dynamically register', async () => {
    for (const metadataClient of [false, true]) {
      const { ctx, service, remote } = await fixture('oauth'); remote.metadataClient = metadataClient
      const result = await service.createServer(ctx, { ...input, auth: metadataClient ? { type: 'oauth' } : { type: 'oauth', clientId: 'existing-client', clientSecret: 'client-secret' } })
      expect(result.url).toBeDefined(); expect(remote.registrations).toBe(0)
      const url = new URL(result.url!)
      expect(url.searchParams.get('client_id')).toBe(metadataClient ? 'https://lovbase.example/api/integrations/mcp/client-metadata' : 'existing-client')
      expect(await service.completeOAuth(ctx, { state: url.searchParams.get('state')!, code: 'code' })).toContain('connected')
    }
  })

  test('denial, expiry, account mismatch and disable cannot activate a project', async () => {
    const { ctx, service } = await fixture('oauth'), other = await fixture()
    const result = await service.createServer(ctx, { ...input, auth: { type: 'oauth' }, projectId: ctx.project.id })
    let state = new URL(result.url!).searchParams.get('state')!
    await expect(service.completeOAuth(other.ctx, { state, code: 'code' })).rejects.toThrow()
    expect(await service.completeOAuth(ctx, { state, error: 'access_denied' })).toContain('cancelled')
    expect((await service.listServers(ctx, ctx.project.id)).servers[0].enabled).toBe(false)
    const retry = await service.reconnectServer(ctx, { serverId: result.serverId })
    state = new URL(retry.url!).searchParams.get('state')!
    await query("UPDATE public.lb_mcp_oauth_sessions SET expires_at=now()-interval '1 minute' WHERE state=$1", [state])
    await expect(service.completeOAuth(ctx, { state, code: 'code' })).rejects.toThrow()
    const again = await service.reconnectServer(ctx, { serverId: result.serverId })
    state = new URL(again.url!).searchParams.get('state')!
    await service.setAccountEnabled(ctx, result.serverId, false)
    await expect(service.completeOAuth(ctx, { state, code: 'code' })).rejects.toThrow()
  })

  test('refresh failure requires user reauthorization without browser redirects from an Agent call', async () => {
    const { ctx, service, remote } = await fixture('oauth')
    const result = await service.createServer(ctx, { ...input, auth: { type: 'oauth' }, projectId: ctx.project.id })
    await service.completeOAuth(ctx, { state: new URL(result.url!).searchParams.get('state')!, code: 'code' })
    await expireToken(result.serverId); remote.refreshFails = true
    await expect(service.callTool(ctx.user.id, ctx.project.id, result.serverId, 'read', {})).rejects.toThrow('Authorization required')
    expect((await service.listServers(ctx)).servers[0].state).toBe('auth_required')
  })
})

describe('MCP registry compatibility', () => {
  test('sync keeps server ids, credentials and project associations; registry token never reaches server', async () => {
    const { ctx, service, remote } = await fixture()
    const registry = await service.createRegistry(ctx, { url: 'https://registry.example.test/v0/servers', bearerToken: 'registry-secret' })
    const server = (await service.listServers(ctx)).servers[0]
    await service.setServerEnabled(ctx, server.id, true)
    await service.toolsForProject(ctx.user.id, ctx.project.id)
    expect(remote.requests.filter(req => new URL(req.url).hostname === 'server.example.test').every(req => !req.headers.has('authorization'))).toBe(true)
    await service.syncRegistry(ctx, registry.registries[0].id)
    expect((await service.listServers(ctx, ctx.project.id)).servers[0]).toMatchObject({ id: server.id, enabled: true, source: 'registry' })
    remote.mode = 'token'
    expect((await service.reconnectServer(ctx, { serverId: server.id, auth: { type: 'token', token: 'api-secret' } })).error).toBeUndefined()
    await service.syncRegistry(ctx, registry.registries[0].id)
    expect((await service.toolsForProject(ctx.user.id, ctx.project.id))[0].tools).toHaveLength(2)
    remote.entries = []
    await service.syncRegistry(ctx, registry.registries[0].id)
    expect(await service.toolsForProject(ctx.user.id, ctx.project.id)).toHaveLength(0)
  })
})

describe('MCP Agent tools', () => {
  test('read tools run, writes require matching approval, denial and replay do not call the server', async () => {
    const { ctx, service, remote } = await fixture()
    const connected = await service.createServer(ctx, { ...input, projectId: ctx.project.id })
    const stub = {} as any
    const agent = new AgentService(stub, stub, stub, stub, stub, { configured: false } as any, stub, stub, stub, cfg, stub, { enabled: false } as any, service)
    const tools = await (agent as any).tools(ctx.project, {}, ctx.project.id, ctx.user.id)
    const read = Object.values(tools).find((tool: any) => tool.mcpToolName === 'read') as any
    const write = Object.values(tools).find((tool: any) => tool.mcpToolName === 'write') as any
    expect(read.mcpNeedsApproval).toBe(false); expect(write.mcpNeedsApproval).toBe(true)
    expect(await read.execute({}, { toolCallId: 'read-1' })).toMatchObject({ content: [{ text: 'tool:read' }] })
    expect(await write.execute({ value: 1 }, { toolCallId: 'write-1' })).toHaveProperty('error')
    expect(remote.toolCalls).toBe(1)
    await service.createApproval(ctx.user.id, ctx.project.id, undefined, connected.serverId, 'write', { value: 1 }, 'write-1')
    await service.reconcileApprovalResponses(ctx.user.id, ctx.project.id, [{ toolCallId: 'write-1', approval: { id: 'ui-approval', approved: true } }])
    expect(await write.execute({ value: 2 }, { toolCallId: 'write-1' })).toHaveProperty('error')
    expect(await write.execute({ value: 1 }, { toolCallId: 'write-1' })).toMatchObject({ content: [{ text: 'tool:write' }] })
    expect(await write.execute({ value: 1 }, { toolCallId: 'write-1' })).toHaveProperty('error')
    await service.createApproval(ctx.user.id, ctx.project.id, undefined, connected.serverId, 'write', {}, 'write-denied')
    await service.reconcileApprovalResponses(ctx.user.id, ctx.project.id, [{ toolCallId: 'write-denied', approval: { id: 'ui-denied', approved: false } }])
    expect(await write.execute({}, { toolCallId: 'write-denied' })).toHaveProperty('error')
    expect(remote.toolCalls).toBe(2)
  })
})

describe('MCP schema upgrades', () => {
  test('upgrades existing registry servers without losing IDs or project selections and is repeatable', async () => {
    const legacy = new PGlite()
    try {
      await legacy.exec(`CREATE TABLE public."user"(id text PRIMARY KEY);
        CREATE TABLE public.lb_projects(id text PRIMARY KEY);
        CREATE TABLE public.lb_apps(id text PRIMARY KEY);
        INSERT INTO public."user" VALUES('owner'); INSERT INTO public.lb_projects VALUES('project');`)
      const firstNewMigration = integrationSchema.findIndex(sql => sql.includes('ALTER COLUMN registry_id DROP NOT NULL'))
      for (const sql of integrationSchema.slice(0, firstNewMigration)) await legacy.exec(sql)
      await legacy.exec(`INSERT INTO public.lb_mcp_registries(id,user_id,url,display_name) VALUES('registry','owner','https://example.com','Registry');
        INSERT INTO public.lb_mcp_servers(id,registry_id,remote_id,name,endpoint) VALUES('stable-id','registry','remote','Existing','https://example.com/mcp');
        CREATE TABLE public.lb_project_mcp_servers(project_id text REFERENCES public.lb_projects(id),server_id text REFERENCES public.lb_mcp_servers(id) ON DELETE CASCADE,enabled boolean DEFAULT true,allowed_tools jsonb,PRIMARY KEY(project_id,server_id));
        INSERT INTO public.lb_project_mcp_servers(project_id,server_id) VALUES('project','stable-id');`)
      for (const sql of integrationSchema) await legacy.exec(sql)
      for (const sql of integrationSchema) await legacy.exec(sql)
      const result = await legacy.query('SELECT s.id,s.user_id,s.auth_type,pc.enabled FROM public.lb_mcp_servers s JOIN public.lb_project_mcp_servers pc ON pc.server_id=s.id')
      expect(result.rows).toEqual([{ id: 'stable-id', user_id: 'owner', auth_type: 'none', enabled: true }])
    } finally { await legacy.close() }
  })
})
