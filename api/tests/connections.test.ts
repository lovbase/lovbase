import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import type pg from 'pg'
import { emptyIR } from '@lovbase/core/ir'
import type { ConnectAccount } from '@lovbase/core/connections'
import { ConfigService } from '../src/config/config.service'
import { SchemaService } from '../src/database/schema.service'
import type { ProjectCtx } from '../src/modules/auth/access.service'
import { ConnectionsService } from '../src/modules/integrations/connections.service'
import { integrationSchema } from '../src/modules/integrations/schema'

const db = new PGlite()
let tail = Promise.resolve()
async function query(sql: string, args?: unknown[]) { const r = await db.query(sql, args); return { rows: r.rows, rowCount: r.affectedRows || r.rows.length } }
const pool = { query, connect: async () => {
  const before = tail; let release!: () => void; tail = new Promise(resolve => { release = resolve }); await before
  return { query, release }
} } as unknown as pg.Pool
const schema = new SchemaService(pool)
let seq = 0, syncFails = false, deleteFails = false, keyActive = true
const remote = new Map<string, { user: string; active: boolean; identity: string; identityId: string }>()
const provider = {
  enabled: true,
  authentication: async (slug: string) => ({ app: { slug, name: slug, logo: null }, methods: [{ scheme: slug === 'perplexityai' ? 'API_KEY' : 'OAUTH2', fields: slug === 'perplexityai' ? [
    { name: 'custom_key', label: 'API Key', required: true, secret: true }, { name: 'tenant', label: 'Tenant', required: true, secret: false },
  ] : [] }] }),
  createAuthConfig: async (toolkit: string) => `auth-${toolkit}`,
  authorize: async (user: string) => {
    const accountId = `remote-${++seq}`
    remote.set(accountId, { user, active: true, identity: `${accountId}@example.test`, identityId: accountId })
    return { accountId, url: `https://connect.example.test/${accountId}` }
  },
  connectKey: async (user: string, _auth: string, fields: Record<string, string>) => {
    expect(fields.custom_key).toBe('TEST-SECRET')
    expect(fields.tenant).toBe('test-tenant')
    expect(fields.unexpected).toBeUndefined()
    const accountId = `key-${++seq}`
    remote.set(accountId, { user, active: keyActive, identity: '', identityId: '' })
    return accountId
  },
  account: async (user: string, account: string) => {
    if (syncFails) throw new Error('TEST-SECRET remote unavailable')
    const a = remote.get(account)
    return { active: a?.user === user && a.active, status: a?.active ? 'ACTIVE' : 'REVOKED', identity: a?.identity ?? null }
  },
  profile: async (account: string) => ({ identity: remote.get(account)?.identity || null, identityId: remote.get(account)?.identityId || null }),
  disconnect: async (account: string) => { if (deleteFails) throw new Error('remote unavailable'); remote.delete(account) },
}
const service = new ConnectionsService(pool, schema, ConfigService.of({ COMPOSIO_API_KEY: 'test-key' }), provider as any)
async function fixture() {
  const id = `conn-${++seq}`
  await query('INSERT INTO public."user"(id,name,email,"createdAt","updatedAt") VALUES ($1,$1,$2,now(),now())', [id, `${id}@test.invalid`])
  await query('INSERT INTO public.lb_projects(id,owner_id,ir) VALUES($1,$1,$2)', [id, JSON.stringify(emptyIR())])
  return { user: { id }, project: { id } } as ProjectCtx
}
async function oauth(ctx: ProjectCtx, toolkit = 'googlesheets') {
  const request = await service.connect(ctx, { toolkit, fields: {}, label: '', projectId: ctx.project.id })
  const attempt = (await query('SELECT * FROM public.lb_connection_attempts WHERE connection_id=$1 ORDER BY created_at DESC', [request.id])).rows[0] as any
  return { request, attempt }
}
async function connected(ctx: ProjectCtx, toolkit = 'googlesheets') {
  const { request, attempt } = await oauth(ctx, toolkit)
  await service.complete(ctx, attempt.state, attempt.account_id, 'success')
  return request.id
}
beforeAll(() => schema.ready(), 30_000)
afterAll(() => db.close())

describe('multi-app account management', () => {
  test('first-time authorizations stay out of account lists until the validated callback succeeds', async () => {
    const ctx = await fixture()
    const pending = await oauth(ctx)
    // The provider may already report ACTIVE, but the local authorization attempt still needs validation.
    expect((await service.list(ctx, true)).connections).toEqual([])
    expect((await service.projectState(ctx)).connections).toEqual([])
    expect((await service.owned(ctx.user.id, pending.request.id)).connected_at).toBeNull()
    await expect(service.setEnabled(ctx, pending.request.id, true)).rejects.toThrow('Reconnect')

    remote.set(pending.attempt.account_id, { ...remote.get(pending.attempt.account_id)!, identity: '', identityId: '' })
    await service.complete(ctx, pending.attempt.state, pending.attempt.account_id, 'success')
    expect((await service.list(ctx)).connections.map(c => c.id)).toEqual([pending.request.id])
    expect((await service.list(ctx)).connections[0]?.identity).toBeNull()
    expect((await service.owned(ctx.user.id, pending.request.id)).connected_at).not.toBeNull()

    const cancelled = await oauth(ctx), abandoned = await oauth(ctx, 'github')
    await service.complete(ctx, cancelled.attempt.state, undefined, 'failed')
    await query("UPDATE public.lb_connection_attempts SET created_at=now()-interval '31 minutes' WHERE state=$1", [abandoned.attempt.state])
    await expect(service.complete(ctx, abandoned.attempt.state, abandoned.attempt.account_id, 'success')).rejects.toThrow('invalid or expired')
    // Refreshing or rerunning migrations must not promote a failed/expired first authorization.
    for (const sql of integrationSchema) await query(sql)
    const view = await service.list(ctx, true)
    expect(view.connections.map(c => c.id)).toEqual([pending.request.id])
    expect(view.syncFailed).toBe(false)
    expect((await service.owned(ctx.user.id, cancelled.request.id)).connected_at).toBeNull()
    expect((await service.owned(ctx.user.id, abandoned.request.id)).connected_at).toBeNull()
  })
  test('groups safe provider identity and project references without automatically granting access', async () => {
    const ctx = await fixture()
    const a = await connected(ctx), b = await connected(ctx), github = await connected(ctx, 'github')
    let state = await service.projectState(ctx)
    expect(state.connections).toHaveLength(3)
    expect(state.enabledIds).toEqual([])
    expect(state.connections.find(c => c.id === github)?.toolkit).toBe('github')
    expect(state.connections.find(c => c.id === a)?.identity).toContain('@example.test')
    await service.setEnabled(ctx, a, true); await service.setEnabled(ctx, b, true)
    state = await service.projectState(ctx)
    expect(state.enabledIds.sort()).toEqual([a, b].sort())
    expect(state.defaults.googlesheets).toBe(a)
    expect(state.connections.find(c => c.id === a)?.projects[0]?.id).toBe(ctx.project.id)
    await service.setDefault(ctx, b)
    expect((await service.active(ctx.user.id, ctx.project.id)).id).toBe(b)
    expect((await service.active(ctx.user.id, ctx.project.id, pool, a)).id).toBe(a)
    await service.setEnabled(ctx, b, false)
    expect((await service.projectState(ctx)).selectedId).toBeNull()
    await expect(service.active(ctx.user.id, ctx.project.id)).rejects.toThrow('default')
    await service.setEnabled(ctx, b, true)
    expect((await service.projectState(ctx)).selectedId).toBeNull()
  })
  test('dynamic API key fields are validated, stripped and never persisted or returned', async () => {
    const ctx = await fixture()
    const input: ConnectAccount = { toolkit: 'perplexityai', authScheme: 'API_KEY', label: 'Work key', fields: { custom_key: 'TEST-SECRET', tenant: 'test-tenant', unexpected: 'ignored' } }
    await expect(service.connect(ctx, { ...input, fields: { custom_key: 'TEST-SECRET' } })).rejects.toThrow('Tenant')
    const r = await service.connect(ctx, input)
    expect(r.url).toBeNull()
    const state = await service.list(ctx)
    expect(state.connections[0]?.label).toBe('Work key')
    expect(state.connections[0]?.identity).toBeNull()
    expect(JSON.stringify(state)).not.toContain('TEST-SECRET')
    expect(JSON.stringify((await query('SELECT * FROM public.lb_connections WHERE user_id=$1', [ctx.user.id])).rows)).not.toContain('TEST-SECRET')
    keyActive = false
    try { await expect(service.connect(ctx, input)).rejects.toThrow('not accepted') } finally { keyActive = true }
    expect((await service.list(ctx, true)).connections.map(c => c.id)).toEqual([r.id])
    syncFails = true
    try { await expect(service.connect(ctx, input)).rejects.toThrow('Could not verify this connection') } finally { syncFails = false }
    expect((await query('SELECT state FROM public.lb_connections WHERE user_id=$1 AND state=$2', [ctx.user.id, 'pending'])).rows).toEqual([])
    expect((await service.list(ctx, true)).connections.map(c => c.id)).toEqual([r.id])
  })
  test('ownership, project hijacking, forged, expired and replayed callbacks are rejected', async () => {
    const ctx = await fixture(), other = await fixture()
    const { request, attempt } = await oauth(ctx)
    await expect(service.complete(other, attempt.state, attempt.account_id, 'success')).rejects.toThrow('invalid or expired')
    await expect(service.complete(ctx, attempt.state, 'wrong-remote', 'success')).rejects.toThrow('invalid or expired')
    await expect(service.connect(other, { toolkit: 'github', label: '', fields: {}, projectId: ctx.project.id })).rejects.toThrow('Project not found')
    await expect(service.rename(other, request.id, 'steal')).rejects.toThrow('not found')
    await expect(service.disconnect(other, request.id)).rejects.toThrow('not found')
    await expect(service.setEnabled(other, request.id, true)).rejects.toThrow('not found')
    await service.complete(ctx, attempt.state, attempt.account_id, 'success')
    await expect(service.setEnabled({ ...ctx, project: other.project }, request.id, true)).rejects.toThrow('Project not found')
    await expect(service.complete(ctx, attempt.state, attempt.account_id, 'success')).rejects.toThrow('invalid or expired')
    const expired = await oauth(ctx)
    await query("UPDATE public.lb_connection_attempts SET created_at=now()-interval '31 minutes' WHERE state=$1", [expired.attempt.state])
    await expect(service.complete(ctx, expired.attempt.state, expired.attempt.account_id, 'success')).rejects.toThrow('invalid or expired')
  })
  test('reconnect failures and identity mismatches retain the original account and its project bindings', async () => {
    const ctx = await fixture(), id = await connected(ctx)
    await service.setEnabled(ctx, id, true)
    const original = await service.owned(ctx.user.id, id)
    async function reconnect() {
      await service.connect(ctx, { toolkit: 'googlesheets', fields: {}, label: '', reconnectId: id })
      return (await query('SELECT * FROM public.lb_connection_attempts WHERE connection_id=$1 AND consumed_at IS NULL', [id])).rows[0] as any
    }
    let a = await reconnect()
    expect(await service.complete(ctx, a.state, a.account_id, 'failed')).toContain('connections=failed')
    expect((await service.owned(ctx.user.id, id)).account_id).toBe(original.account_id)
    expect((await service.list(ctx, true)).connections.map(c => c.id)).toEqual([id])
    expect((await service.owned(ctx.user.id, id)).connected_at).toEqual(original.connected_at)
    a = await reconnect()
    expect(await service.complete(ctx, a.state, a.account_id, 'success')).toContain('identity_changed')
    expect((await service.owned(ctx.user.id, id)).account_id).toBe(original.account_id)
    a = await reconnect()
    remote.set(a.account_id, { ...remote.get(original.account_id)! })
    await service.complete(ctx, a.state, a.account_id, 'success')
    expect((await service.owned(ctx.user.id, id)).account_id).toBe(a.account_id)
    expect((await service.projectState(ctx)).selectedId).toBe(id)
    expect(remote.has(original.account_id)).toBe(false)
  })
  test('remote outages preserve saved accounts, while revocation updates the status', async () => {
    const ctx = await fixture(), id = await connected(ctx)
    syncFails = true
    try {
      const view = await service.list(ctx, true)
      expect(view.syncFailed).toBe(true)
      expect(view.connections[0]?.state).toBe('active')
      expect(JSON.stringify(view)).not.toContain('TEST-SECRET')
    } finally { syncFails = false }
    const c = await service.owned(ctx.user.id, id)
    remote.get(c.account_id)!.active = false
    expect((await service.list(ctx, true)).connections[0]?.state).toBe('expired')
  })
  test('disconnect blocks local access immediately, supports retry and rejects an outstanding callback', async () => {
    const ctx = await fixture(), id = await connected(ctx)
    await service.setEnabled(ctx, id, true)
    const pending = await oauth(ctx, 'github')
    deleteFails = true
    try { await expect(service.disconnect(ctx, id)).rejects.toThrow('unavailable') } finally { deleteFails = false }
    expect((await service.owned(ctx.user.id, id)).state).toBe('disconnected')
    expect((await service.projectState(ctx)).enabledIds).not.toContain(id)
    await expect(service.active(ctx.user.id, ctx.project.id, pool, id)).rejects.toThrow('no longer enabled')
    await service.disconnect(ctx, id)
    await expect(service.owned(ctx.user.id, id)).rejects.toThrow('not found')
    await service.disconnect(ctx, pending.request.id)
    await expect(service.complete(ctx, pending.attempt.state, pending.attempt.account_id, 'success')).rejects.toThrow('invalid or expired')
  })
  test('legacy account IDs, imports, defaults and pending callback attempts migrate once', async () => {
    const ctx = await fixture()
    const id = 'legacy-' + ++seq
    await query("INSERT INTO public.lb_connections(id,user_id,account_id,auth_config_id,label,return_path,state,callback_state) VALUES($1,$2,$1,'auth','Personal','/settings','pending',$3)", [id,ctx.user.id,'state-'+seq])
    await query('INSERT INTO public.lb_project_connections VALUES($1,$2)', [ctx.project.id,id])
    for (const sql of integrationSchema) await query(sql)
    expect((await service.projectState(ctx)).selectedId).toBeNull()
    expect((await query('SELECT connection_id FROM public.lb_project_connection_defaults WHERE project_id=$1', [ctx.project.id])).rows[0]).toEqual({ connection_id: id })
    expect((await service.owned(ctx.user.id, id)).toolkit).toBe('googlesheets')
    expect((await query('SELECT connection_id FROM public.lb_connection_attempts WHERE state=$1', ['state-'+seq])).rows[0]).toEqual({ connection_id: id })
    await service.setEnabled(ctx, id, false)
    for (const sql of integrationSchema) await query(sql)
    expect((await service.projectState(ctx)).enabledIds).toEqual([])
    expect((await service.projectState(ctx)).selectedId).toBeNull()
  })
  test('migration preserves established accounts while keeping old unfinished attempts hidden', async () => {
    const ctx = await fixture()
    const states = ['active', 'expired', 'disconnected', 'pending', 'failed']
    const ids = states.map(state => `${ctx.user.id}-${state}`)
    for (let i = 0; i < states.length; i++) await query(`INSERT INTO public.lb_connections
      (id,user_id,account_id,auth_config_id,label,return_path,state) VALUES($1,$2,$1,'auth','Legacy','/settings',$3)`, [ids[i], ctx.user.id, states[i]])
    for (const sql of integrationSchema) await query(sql)
    for (const sql of integrationSchema) await query(sql)
    const records = await query('SELECT id, connected_at FROM public.lb_connections WHERE user_id=$1', [ctx.user.id])
    expect(records.rows.filter((c: any) => c.connected_at).map((c: any) => c.id).toSorted()).toEqual(ids.slice(0, 3).toSorted())
    expect((await service.list(ctx, true)).connections.map(c => c.id).toSorted()).toEqual(ids.slice(0, 3).toSorted())
    expect((await service.list(ctx, true)).connections.map(c => c.id).toSorted()).toEqual(ids.slice(0, 3).toSorted())
  })
  test('OAuth cancellation returns to the original local page without accepting an external redirect', async () => {
    const ctx = await fixture()
    const request = await service.connect(ctx, { toolkit: 'github', fields: {}, label: '', returnPath: '/home?source=connections' })
    const attempt = (await query('SELECT * FROM public.lb_connection_attempts WHERE connection_id=$1', [request.id])).rows[0] as any
    expect(await service.complete(ctx, attempt.state, undefined, 'failed')).toBe('/home?source=connections#connections=failed&view=dialog')
    await expect(service.connect(ctx, { toolkit: 'github', fields: {}, label: '', returnPath: '//example.test' })).rejects.toThrow()
    await expect(service.connect(ctx, { toolkit: 'github', fields: {}, label: '', returnPath: '/\\example.test' })).rejects.toThrow()
  })
})
