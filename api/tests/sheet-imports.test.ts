import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import type pg from 'pg'
import { emptyIR } from '@lovbase/core/ir'
import type { AppCtx } from '../src/modules/auth/access.service'
import { ConfigService } from '../src/config/config.service'
import { SchemaService } from '../src/database/schema.service'
import { ApplyService } from '../src/modules/modeling/apply.service'
import { ProposeService } from '../src/modules/modeling/propose.service'
import { ConversationService } from '../src/modules/projects/conversation.service'
import { JobRepository } from '../src/modules/jobs/job.repository'
import { ConnectionsService } from '../src/modules/integrations/connections.service'
import { SheetImportsService } from '../src/modules/integrations/sheet-imports.service'
import { defaultMapping, snapshotOf } from '../src/modules/integrations/sheets'

// PGlite runs PostgreSQL itself (WASM), so constraints, DDL rollback and parameterized inserts
// are exercised without Docker or a developer's database. The adapter serializes transactions.
const db = new PGlite()
let tail = Promise.resolve()
async function acquire() { const previous = tail; let release!: () => void; tail = new Promise(resolve => { release = resolve }); await previous; return release }
async function query(sql: string, params?: unknown[]) { const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows || r.rows.length } }
const pool = {
  query,
  connect: async () => { const release = await acquire(); return { query, release } },
} as unknown as pg.Pool
const cfg = ConfigService.of({ COMPOSIO_API_KEY: 'test-only-never-sent' })
const schema = new SchemaService(pool)
const jobs = new JobRepository(pool, schema)
const conversation = new ConversationService(pool, schema)
const applier = new ApplyService(pool, { log: async () => {} } as any)
const proposer = new ProposeService({} as any, applier)
let remoteActive = true
const provider = { enabled: true, account: async () => ({ active: remoteActive }), disconnect: async () => {}, read: async () => ({ snapshot: snapshotOf([['客户', '数量'], ['张三', 2], ['李四', 0]], 1), title: '客户' }) }
const connections = new ConnectionsService(pool, schema, cfg, provider as any)
const service = new SheetImportsService(pool, schema, cfg, connections, provider as any, proposer, applier, jobs,
  { enqueue: async () => true } as any, { configFor: async () => ({}) } as any, { assert: async () => {} } as any, conversation)
let counter = 0
async function fixture() {
  const id = `sheettest${++counter}`
  const userId = `${id}user`, cId = `${id}connection`
  await pool.query('INSERT INTO public."user"(id, name, email, "createdAt", "updatedAt") VALUES ($1,$1,$2,now(),now())', [userId, `${id}@test.invalid`])
  await pool.query('INSERT INTO public.lb_projects(id, owner_id, ir) VALUES ($1,$2,$3)', [id, userId, JSON.stringify(emptyIR())])
  await pool.query('INSERT INTO public.lb_apps(id, project_id, name) VALUES ($1,$1,$2)', [id, 'Test'])
  await pool.query(`CREATE SCHEMA "p_${id}"`)
  await pool.query("INSERT INTO public.lb_connections(id,user_id,account_id,auth_config_id,label,return_path,state) VALUES($1,$2,$1,'auth-test','Google','/settings','active')", [cId,userId])
  await pool.query('INSERT INTO public.lb_project_connections(project_id,connection_id) VALUES($1,$2)', [id,cId])
  const project = (await pool.query('SELECT * FROM public.lb_projects WHERE id = $1',[id])).rows[0]
  const ctx = { user: { id: userId, plan: 'free' }, project, app: { id } } as AppCtx
  const preview = await service.prepare(userId, id, id, { url: '1abcdefghijklmnopqrstuvwxyz', sheetId: 0, headerRow: 1, range: '' })
  return { ctx, preview, cId }
}
beforeAll(async () => { await schema.ready() }, 30_000)
afterAll(async () => { await db.close() })

describe('Sheets import transactions and authorization', () => {
  test('preview persists without DDL; confirmation and retry import exactly once', async () => {
    const { ctx, preview } = await fixture()
    expect(preview.rowCount).toBe(2)
    expect((await pool.query('SELECT ir FROM public.lb_projects WHERE id=$1',[ctx.project.id])).rows[0].ir.entities).toHaveLength(0)
    const first = await service.confirm(ctx, preview.id, preview.version)
    const duplicate = await service.confirm(ctx, preview.id, preview.version)
    expect(first.jobId).toBe(duplicate.jobId)
    await service.execute(ctx.user.id, ctx.project.id, ctx.app.id, preview.id, first.jobId)
    await service.execute(ctx.user.id, ctx.project.id, ctx.app.id, preview.id, first.jobId)
    const ir = (await pool.query('SELECT ir FROM public.lb_projects WHERE id=$1',[ctx.project.id])).rows[0].ir
    const rows = await pool.query(`SELECT col_1,col_2 FROM "p_${ctx.project.id}"."${ir.entities[0].dbName}" ORDER BY col_1`)
    expect(rows.rowCount).toBe(2)
    expect(rows.rows.map(r => Number(r.col_2)).sort()).toEqual([0,2])
    expect((await service.get(ctx, preview.id)).status).toBe('imported')
    await jobs.finish(first.jobId, 'failed', 'UI generation failed')
    const retry = await service.confirm(ctx, preview.id, preview.version)
    await service.execute(ctx.user.id, ctx.project.id, ctx.app.id, preview.id, retry.jobId)
    expect((await pool.query(`SELECT count(*)::int n FROM "p_${ctx.project.id}"."${ir.entities[0].dbName}"`)).rows[0].n).toBe(2)
  })
  test('simultaneous confirmations converge on one durable task', async () => {
    const { ctx, preview } = await fixture()
    const results = await Promise.all([service.confirm(ctx, preview.id, preview.version), service.confirm(ctx, preview.id, preview.version)])
    expect(results[0].jobId).toBe(results[1].jobId)
    const count = await pool.query('SELECT count(*)::int n FROM public.lb_jobs WHERE project_id = $1',[ctx.project.id])
    expect(count.rows[0].n).toBe(1)
  })
  test('cross-user access, unenabled projects and forged authorization callbacks fail', async () => {
    const { ctx, preview, cId } = await fixture()
    const other = { ...ctx, user: { ...ctx.user, id: 'another-user' } } as AppCtx
    await expect(service.get(other, preview.id)).rejects.toThrow('Import not found')
    await expect(connections.select(other, cId)).rejects.toThrow('Connection not found')
    await expect(connections.complete(ctx, 'fake-state', cId, 'success')).rejects.toThrow('invalid or expired')
    await connections.select(ctx, null)
    await expect(service.info(ctx.user.id, ctx.project.id, preview.source.url)).rejects.toThrow('Enable')
  })
  test('matching callback IDs are insufficient when remote authorization is revoked', async () => {
    const { ctx, cId } = await fixture()
    await pool.query("UPDATE public.lb_connections SET state='pending',callback_state='valid-state' WHERE id=$1",[cId])
    await expect(connections.complete(ctx, 'valid-state', 'different-account', 'success')).rejects.toThrow('invalid or expired')
    remoteActive = false
    await expect(connections.complete(ctx, 'valid-state', cId, 'success')).rejects.toThrow('not active')
    remoteActive = true
    expect(await connections.complete(ctx, 'valid-state', cId, 'success')).toBe('/settings')
    await expect(connections.complete(ctx, 'valid-state', cId, 'success')).rejects.toThrow('invalid or expired')
  })
  test('edited fields increment versions; conversion errors and stale confirmations cannot write', async () => {
    const { ctx, preview } = await fixture()
    const mapping = defaultMapping(snapshotOf([['客户','数量'],['张三',2]],1),'客户')
    mapping.fields[0].type = 'number'
    const edited = await service.update(ctx, preview.id, preview.version, mapping)
    expect(edited.errors.length).toBeGreaterThan(0)
    await expect(service.confirm(ctx, preview.id, preview.version)).rejects.toThrow('version')
    await expect(service.confirm(ctx, preview.id, edited.version)).rejects.toThrow('conversion')
    expect((await pool.query('SELECT ir FROM public.lb_projects WHERE id=$1',[ctx.project.id])).rows[0].ir.entities).toHaveLength(0)
  })
  test('stale schemas, disabled connections and unconfirmed jobs do not import', async () => {
    const { ctx, preview } = await fixture()
    await expect(service.execute(ctx.user.id,ctx.project.id,ctx.app.id,preview.id,'fake-job')).rejects.toThrow('not confirmed')
    await pool.query("UPDATE public.lb_projects SET ir = jsonb_set(ir,'{appName}','\"Changed\"') WHERE id=$1",[ctx.project.id])
    await expect(service.confirm(ctx,preview.id,preview.version)).rejects.toThrow('data model changed')
    await pool.query('UPDATE public.lb_projects SET ir=$2 WHERE id=$1',[ctx.project.id,JSON.stringify(emptyIR())])
    const job = await service.confirm(ctx,preview.id,preview.version)
    await connections.select(ctx,null)
    await expect(service.execute(ctx.user.id,ctx.project.id,ctx.app.id,preview.id,job.jobId)).rejects.toThrow('Enable')
  })
  test('failure after DDL and row insertion rolls back schema, IR, rows and import receipt', async () => {
    const { ctx, preview } = await fixture()
    const job = await service.confirm(ctx,preview.id,preview.version)
    // Force the final receipt to fail, after all DDL and INSERT statements ran.
    await pool.query(`ALTER TABLE public.lb_sheet_imports ADD CONSTRAINT test_receipt_failure CHECK (id <> '${preview.id}' OR status <> 'imported')`)
    await expect(service.execute(ctx.user.id,ctx.project.id,ctx.app.id,preview.id,job.jobId)).rejects.toThrow()
    expect((await pool.query('SELECT ir FROM public.lb_projects WHERE id=$1',[ctx.project.id])).rows[0].ir.entities).toHaveLength(0)
    expect((await pool.query('SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1',[`p_${ctx.project.id}`])).rows[0].n).toBe(0)
    expect((await service.get(ctx,preview.id)).status).toBe('queued')
    await pool.query('ALTER TABLE public.lb_sheet_imports DROP CONSTRAINT test_receipt_failure')
    // New service invocation, same persisted job, succeeds without any in-memory progress state.
    await service.execute(ctx.user.id,ctx.project.id,ctx.app.id,preview.id,job.jobId)
    expect((await service.get(ctx,preview.id)).status).toBe('imported')
  })
  test('cancelled tasks and quota overflow roll back', async () => {
    const { ctx, preview } = await fixture()
    const job = await service.confirm(ctx,preview.id,preview.version)
    await jobs.requestCancel(ctx.project.id)
    await expect(service.execute(ctx.user.id,ctx.project.id,ctx.app.id,preview.id,job.jobId)).rejects.toThrow('cancelled')
    await pool.query('UPDATE public.lb_jobs SET cancel_requested_at = NULL WHERE id=$1',[job.jobId])
    const previousQuota = cfg.env.FREE_QUOTA_MB
    cfg.env.FREE_QUOTA_MB = 0
    try { await expect(service.execute(ctx.user.id,ctx.project.id,ctx.app.id,preview.id,job.jobId)).rejects.toThrow('quota') }
    finally { cfg.env.FREE_QUOTA_MB = previousQuota }
    expect((await pool.query('SELECT ir FROM public.lb_projects WHERE id=$1',[ctx.project.id])).rows[0].ir.entities).toHaveLength(0)
  })
})
