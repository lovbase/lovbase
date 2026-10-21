import 'reflect-metadata'
import { beforeAll, afterAll, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { createHash } from 'node:crypto'
import express from 'express'
import type pg from 'pg'
import type { INestApplication } from '@nestjs/common'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ConfigService } from '../src/config/config.service'
import { SchemaService } from '../src/database/schema.service'
import { McpOAuthService, MCP_SCOPE } from '../src/modules/mcp-server/oauth.service'
import { McpToolsService } from '../src/modules/mcp-server/tools.service'
import { mountMcp } from '../src/modules/mcp-server/router'
import { AccountsService } from '../src/modules/accounts/accounts.service'
import { AccessService, type UserCtx } from '../src/modules/auth/access.service'
import { AppsService } from '../src/modules/apps/apps.service'
import { ProjectsService } from '../src/modules/projects/projects.service'
import { ConversationService } from '../src/modules/projects/conversation.service'
import { SqlService } from '../src/modules/sql/sql.service'
import { JobRepository } from '../src/modules/jobs/job.repository'
import { sourcePath } from '../src/modules/development/files'

const db = new PGlite()
let tail = Promise.resolve()
async function query(sql: string | { text: string; values: unknown[] }, params?: unknown[]) {
  const r = await db.query(typeof sql === 'string' ? sql : sql.text, typeof sql === 'string' ? params : sql.values)
  return { rows: r.rows, rowCount: r.affectedRows || r.rows.length, fields: r.fields }
}
const pool = { query, connect: async () => {
  const previous = tail; let release!: () => void
  tail = new Promise(resolve => { release = resolve }); await previous
  return { query, release }
} } as unknown as pg.Pool
const schema = new SchemaService(pool)
let cfg: ConfigService, oauth: McpOAuthService, tools: McpToolsService
let origin: string, server: ReturnType<express.Express['listen']>
let clientInfo: any
const verifier = 'v'.repeat(64)
const challenge = createHash('sha256').update(verifier).digest('base64url')
const redirectUri = 'http://127.0.0.1:17892/callback'
const owner = { user: { id: 'owner', email: 'owner@test.invalid', name: 'Owner', image: null, isAdmin: false, plan: 'free' } } as UserCtx
const other = { user: { ...owner.user, id: 'other' } } as UserCtx
let credits = 0, enqueued = 0
let jobs: JobRepository

beforeAll(async () => {
  await schema.ready()
  await query(`INSERT INTO public."user"(id,name,email) VALUES('owner','Owner','owner@test.invalid'),('other','Other','other@test.invalid')`)
  await query(`INSERT INTO public.lb_projects(id,owner_id,name,ir,api_token) VALUES
    ('owned','owner','Owned','{"entities":[]}','DO-NOT-EXPOSE'),('foreign','other','Foreign','{"entities":[]}','FOREIGN-SECRET')`)
  await query(`INSERT INTO public.lb_apps(id,project_id,name) VALUES('app','owned','Main'),('foreign-app','foreign','Foreign')`)
  await query('CREATE SCHEMA p_owned')
  await query('CREATE TABLE p_owned.items(id integer PRIMARY KEY, label text)')
  await query("INSERT INTO p_owned.items VALUES(1,'original')")
  await query('CREATE ROLE ws_owned')
  await query('GRANT USAGE ON SCHEMA p_owned TO ws_owned')
  await query('GRANT SELECT,INSERT,UPDATE,DELETE ON p_owned.items TO ws_owned')
  const http = express()
  await new Promise<void>(resolve => { server = http.listen(0,'127.0.0.1',resolve) })
  origin = `http://127.0.0.1:${(server.address() as any).port}`
  cfg = ConfigService.of({ BETTER_AUTH_URL: origin, MCP_SERVER_ENABLED: 'true' })
  oauth = new McpOAuthService(pool,schema,cfg)
  const accounts = new AccountsService(pool,schema), apps = new AppsService(pool,schema)
  const roles = { ensureWorkspaceRole: async () => 'ws_owned' }
  const projects = new ProjectsService(pool,schema,roles as any)
  const access = new AccessService({} as any,accounts,projects,apps,cfg)
  jobs = new JobRepository(pool,schema)
  tools = new McpToolsService(pool,access,accounts,projects,apps,{ write: async (_ctx: unknown,path: string) => ({ ok: true,path,version: 2 }) } as any,new SqlService(pool,pool),roles as any,
    { allowRequest: () => true, assertWithinQuota: async () => {} } as any,
    { parse: (v: unknown) => v, propose: async () => ({ applied: false,needsConfirmation: true,pendingId: 'pending',changes: [] }) } as any,
    { assert: async () => { credits++ } } as any,{ configFor: async () => ({}) } as any,jobs,
    { enqueue: async () => { enqueued++; return true }, cancel: async () => {} } as any,new ConversationService(pool,schema),cfg)
  const values = new Map<any,any>([[ConfigService,cfg],[McpOAuthService,oauth],[McpToolsService,tools]])
  mountMcp({ get: (key: any) => values.get(key),getHttpAdapter: () => ({ getInstance: () => http }) } as unknown as INestApplication)
  http.get('/mcp/authorize',(_req,res) => { res.send('consent UI') })
  const response = await fetch(origin+'/register',{ method: 'POST',headers: { 'content-type':'application/json' },body: JSON.stringify({ client_name:'Test client', redirect_uris:[redirectUri], token_endpoint_auth_method:'none' }) })
  expect(response.status).toBe(201)
  clientInfo = await response.json()
},30_000)
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.close() })

async function authorization(ctx: UserCtx = owner) {
  const params = new URLSearchParams({ client_id: clientInfo.client_id,redirect_uri: redirectUri,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:MCP_SCOPE,state:'client-state',resource:origin+'/mcp' })
  const r = await fetch(origin+'/authorize?'+params,{ redirect:'manual' })
  expect(r.status).toBe(302)
  const location = new URL(r.headers.get('location')!)
  const request = location.searchParams.get('request')!
  expect((await fetch(location)).status).toBe(200)
  await oauth.consentRequest(ctx,request)
  return request
}
async function token(code: string, extra: Record<string,string> = {}) {
  return fetch(origin+'/token',{ method:'POST',body:new URLSearchParams({ grant_type:'authorization_code',client_id:clientInfo.client_id,code,redirect_uri:redirectUri,code_verifier:verifier,resource:origin+'/mcp',...extra }) })
}
async function grant() {
  const request = await authorization()
  const { redirect } = await oauth.decide(owner,request,true)
  expect(new URL(redirect).searchParams.get('state')).toBe('client-state')
  const code = new URL(redirect).searchParams.get('code')!
  const response = await token(code)
  expect(response.status).toBe(200)
  return { ...await response.json() as any,code }
}
async function connect(accessToken: string) {
  const client = new Client({ name:'test-client',version:'1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{ requestInit: { headers:{ Authorization:`Bearer ${accessToken}` } } }))
  return client
}

test('discovery, stateless protocol and consent route coexist',async () => {
  const unauthorized = await fetch(origin+'/mcp')
  expect(unauthorized.status).toBe(401)
  expect(unauthorized.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp')
  const prm = await (await fetch(origin+'/.well-known/oauth-protected-resource/mcp')).json() as any
  expect(prm.resource).toBe(origin+'/mcp')
  const meta = await (await fetch(origin+'/.well-known/oauth-authorization-server')).json() as any
  expect(meta.code_challenge_methods_supported).toEqual(['S256'])
  const g = await grant(), client = await connect(g.access_token)
  try {
    const list = await client.listTools()
    expect(list.tools).toHaveLength(19)
    expect(list.tools.every(t => t.inputSchema && t.outputSchema)).toBe(true)
    expect(list.tools.find(t => t.name==='query_database')?.annotations?.readOnlyHint).toBe(true)
    expect(list.tools.some(t => /delete_project|delete_app|unpublish/.test(t.name))).toBe(false)
    const write = await client.callTool({ name:'write_file',arguments:{projectId:'owned',appId:'app',path:'src/App.tsx',content:'test',expectedVersion:1} })
    expect(write.structuredContent).toEqual({version:2})
    const result = await client.callTool({ name:'list_projects',arguments:{} })
    expect(JSON.stringify(result)).toContain('Owned')
    expect(JSON.stringify(result)).not.toContain('Foreign')
    expect(JSON.stringify(result)).not.toContain('DO-NOT-EXPOSE')
    const denied = await client.callTool({ name:'get_project',arguments:{ projectId:'foreign' } })
    expect(denied.isError).toBe(true)
    const foreignApp = await client.callTool({ name:'rename_app',arguments:{ projectId:'owned',appId:'foreign-app',name:'bad' } })
    expect(foreignApp.isError).toBe(true)
  } finally { await client.close() }
})

test('PKCE, callback, resource, consent binding, expiry and one-use codes',async () => {
  const request = await authorization()
  await expect(oauth.consentRequest(other,request)).rejects.toThrow()
  await expect(oauth.decide(other,request,true)).rejects.toThrow()
  const { redirect } = await oauth.decide(owner,request,true)
  const code = new URL(redirect).searchParams.get('code')!
  expect((await token(code,{ code_verifier:'wrong' })).status).toBe(400)
  expect((await token(code,{ redirect_uri:'http://127.0.0.1:17892/other' })).status).toBe(400)
  expect((await token(code,{ resource:origin+'/wrong' })).status).toBe(400)
  expect((await token(code)).status).toBe(200)
  expect((await token(code)).status).toBe(400)
  await expect(oauth.decide(owner,request,true)).rejects.toThrow()
  const expired = await authorization()
  await query("UPDATE public.lb_mcp_authorizations SET expires_at=now()-interval '1 second' WHERE id=$1",[expired])
  await expect(oauth.decide(owner,expired,true)).rejects.toThrow()
  const refused = await authorization()
  const denial = await oauth.decide(owner,refused,false)
  expect(new URL(denial.redirect).searchParams.get('error')).toBe('access_denied')
  const bad = await fetch(origin+'/authorize?'+new URLSearchParams({ client_id:clientInfo.client_id,redirect_uri:'https://attacker.test/callback' }),{redirect:'manual'})
  expect(bad.status).toBe(400); expect(bad.headers.get('location')).toBeNull()
})

test('refresh rotates, replay revokes grant, and tokens survive provider reconstruction',async () => {
  const g = await grant()
  const restarted = new McpOAuthService(pool,schema,cfg)
  expect((await restarted.verifyAccessToken(g.access_token)).extra.userId).toBe('owner')
  const rotated = await restarted.exchangeRefreshToken(clientInfo,g.refresh_token)
  expect(rotated.refresh_token).not.toBe(g.refresh_token)
  await expect(restarted.exchangeRefreshToken(clientInfo,g.refresh_token)).rejects.toThrow()
  await expect(restarted.verifyAccessToken(rotated.access_token)).rejects.toThrow()
  const fresh = await grant()
  const info = await restarted.verifyAccessToken(fresh.access_token)
  await restarted.revoke(other,info.extra.grantId)
  await expect(restarted.verifyAccessToken(fresh.access_token)).resolves.toBeDefined()
  await restarted.revoke(owner,info.extra.grantId)
  await expect(restarted.verifyAccessToken(fresh.access_token)).rejects.toThrow()
  await expect(restarted.exchangeRefreshToken(clientInfo,fresh.refresh_token)).rejects.toThrow()
  const rows = await query('SELECT hash FROM public.lb_mcp_tokens')
  expect(JSON.stringify(rows.rows)).not.toContain(fresh.access_token)
})

test('SQL uses database read-only transactions and structure proposals remain pending',async () => {
  const g = await grant(), client = await connect(g.access_token)
  try {
    expect((await client.callTool({ name:'query_database',arguments:{projectId:'owned',sql:"UPDATE items SET label='forbidden' WHERE id=1"} })).isError).toBe(true)
    const result = await client.callTool({ name:'query_database',arguments:{projectId:'owned',sql:'SELECT * FROM items'} })
    expect(JSON.stringify(result)).toContain('original')
    expect((await client.callTool({ name:'execute_database',arguments:{projectId:'owned',sql:'UPDATE items SET label=$1 WHERE id=$2',params:['changed',1]} })).isError).not.toBe(true)
    expect((await client.callTool({ name:'execute_database',arguments:{projectId:'owned',sql:'DROP TABLE items'} })).isError).toBe(true)
    expect((await client.callTool({ name:'query_database',arguments:{projectId:'owned',sql:'SELECT * FROM public.lb_mcp_tokens'} })).isError).toBe(true)
    const proposal = await client.callTool({ name:'propose_schema',arguments:{projectId:'owned',ir:{entities:[]}} })
    expect(proposal.structuredContent).toMatchObject({applied:false,needsConfirmation:true,pendingId:'pending'})
  } finally { await client.close() }
})

test('durable tasks are scoped, idempotent and do not overwrite conversations for builds',async () => {
  const g = await grant(), client = await connect(g.access_token)
  try {
    await query(`INSERT INTO public.lb_chat(project_id,messages) VALUES('owned','[{"id":"old","role":"user","parts":[{"type":"text","text":"Keep me"}]}]')`)
    const args = {projectId:'owned',appId:'app',requestId:'build-one'}
    const first = await client.callTool({name:'build_app',arguments:args})
    expect(first.isError).not.toBe(true)
    const taskId = (first.structuredContent as any).taskId
    // Use a real bearer token for the second account to exercise the HTTP ownership boundary.
    const foreignRequest = await authorization(other)
    const foreignDecision = await oauth.decide(other,foreignRequest,true)
    const foreignTokens = await (await token(new URL(foreignDecision.redirect).searchParams.get('code')!)).json() as any
    const foreignClient = await connect(foreignTokens.access_token)
    try {
      expect((await foreignClient.callTool({name:'get_task',arguments:{taskId}})).isError).toBe(true)
      expect((await foreignClient.callTool({name:'cancel_task',arguments:{taskId}})).isError).toBe(true)
    } finally { await foreignClient.close() }
    const second = await client.callTool({name:'build_app',arguments:args})
    expect((second.structuredContent as any).taskId).toBe(taskId)
    expect(enqueued).toBe(1); expect(credits).toBe(0)
    expect(JSON.stringify((await query("SELECT messages FROM public.lb_chat WHERE project_id='owned'")).rows)).toContain('Keep me')
    await jobs.finish(taskId,'succeeded',undefined,{ok:true,url:'https://example.test'})
    const task = await client.callTool({name:'get_task',arguments:{taskId}})
    expect(task.structuredContent).toMatchObject({status:'succeeded',result:{ok:true,url:'https://example.test'}})
    const agent = await client.callTool({name:'start_agent_run',arguments:{...args,requestId:'agent-one',prompt:'Build a CRM'}})
    expect(agent.isError).not.toBe(true); expect(credits).toBe(1)
    const mismatch = await client.callTool({name:'start_agent_run',arguments:{...args,requestId:'agent-one',prompt:'Different prompt'}})
    expect(mismatch.isError).toBe(true)
    await client.callTool({name:'cancel_task',arguments:{taskId:(agent.structuredContent as any).taskId}})
    const cancelled = await client.callTool({name:'get_task',arguments:{taskId:(agent.structuredContent as any).taskId}})
    expect(cancelled.structuredContent).toMatchObject({status:'cancelled'})
  } finally { await client.close() }
})

test('source paths refuse traversal and credential/internal files',() => {
  for (const path of ['../secret','/etc/passwd','src/../../x','src\\x','.env','.env.production','src/.env','.git/config','AGENTS.md','src/AGENTS.md','a\0b','.ssh/id_rsa','.pi/agent/models.json','dist/index.html']) expect(() => sourcePath(path)).toThrow()
  expect(sourcePath('src/components/App.tsx')).toBe('src/components/App.tsx')
})
