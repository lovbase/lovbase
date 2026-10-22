import 'reflect-metadata'
import { afterAll, beforeAll, describe, test, expect } from 'bun:test'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { ModelMeterService } from '../src/modules/billing/model-meter.service'
import { RatesService } from '../src/modules/billing/rates.service'
import { StorageReconciler } from '../src/modules/storage/storage-reconciler.service'
import { StorageService } from '../src/modules/storage/storage.service'
import { chatAttachmentKey } from '../src/modules/storage/keys'
import { createHash } from 'node:crypto'
import { ConfigService } from '../src/config/config.service'
import { SchemaService } from '../src/database/schema.service'
import { LimitsService } from '../src/modules/limits/limits.service'
import { ProjectsService } from '../src/modules/projects/projects.service'
import { RolesService } from '../src/modules/roles/roles.service'
import { AppsService } from '../src/modules/apps/apps.service'
import { DirectDatabaseService } from '../src/modules/entitlements/direct-database.service'
import { ExportsService } from '../src/modules/entitlements/exports.service'
import { SqlService } from '../src/modules/sql/sql.service'
import { CreditsService } from '../src/modules/credits/credits.service'
import { GenerationService } from '../src/modules/agent/generation.service'
import type { ProjectCtx } from '../src/modules/auth/access.service'

const url = process.env.ENTITLEMENTS_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
suite('account entitlements on real PostgreSQL', () => {
  const pool = new pg.Pool({ connectionString: url })
  const cfg = ConfigService.of({
    DATABASE_URL: url,
    DATABASE_PUBLIC_HOST: new URL(url ?? 'postgres://localhost/test').hostname,
    DATABASE_PUBLIC_PORT: Number(new URL(url ?? 'postgres://localhost/test').port || 5432),
    DATABASE_PUBLIC_SSLMODE: 'disable',
    PG_DUMP_PATH: process.env.TEST_PG_DUMP_PATH ?? 'pg_dump',
  })
  const schema = new SchemaService(pool),
    limits = new LimitsService(pool, cfg, schema),
    roles = new RolesService(pool, cfg)
  const projects = new ProjectsService(pool, schema, roles, limits),
    apps = new AppsService(pool, schema, limits)
  const direct = new DirectDatabaseService(pool, cfg, schema, limits),
    exports = new ExportsService(pool, cfg, limits)
  const sql = new SqlService(pool, pool, limits),
    credits = new CreditsService(pool, schema)
  const users: string[] = [],
    ids: string[] = []
  async function fixture(plan = 'pro'): Promise<ProjectCtx> {
    const id = 'entitlement-' + randomUUID()
    users.push(id)
    await pool.query(
      'INSERT INTO public."user"(id,name,email,plan,"createdAt","updatedAt") VALUES($1,$1,$2,$3,now(),now())',
      [id, id + '@test.invalid', plan],
    )
    const project = await projects.create(id)
    ids.push(project.id)
    return {
      project,
      user: { id, name: id, email: id + '@test.invalid', image: null, isAdmin: false, plan: plan as any },
    }
  }
  async function bytes(stream: NodeJS.ReadableStream) {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }
  beforeAll(async () => {
    await schema.ready()
  }, 30000)
  afterAll(async () => {
    for (const id of ids) await projects.remove(id)
    for (const id of users) await pool.query('DELETE FROM public."user" WHERE id=$1', [id])
    await pool.end()
  }, 30000)
  test('expired Pro cannot create a third project or obtain exclusive capabilities', async () => {
    const ctx = await fixture()
    const p = await projects.create(ctx.user.id)
    ids.push(p.id)
    await pool.query(
      `UPDATE public."user" SET stripe_subscription_id='sub_expired',stripe_paid_until=now()-interval '1 second' WHERE id=$1`,
      [ctx.user.id],
    )
    await expect(projects.create(ctx.user.id)).rejects.toThrow('Project limit')
    await expect(exports.sql(ctx)).rejects.toThrow('Pro')
    await expect(direct.create(ctx)).rejects.toThrow('Pro')
    expect((await limits.usage(ctx.user.id)).plan).toBe('free')
    expect((await projects.listFor(ctx.user.id)).length).toBe(2)
  })
  test('account-wide concurrent reservations cannot spend the same capacity twice', async () => {
    const ctx = await fixture('free'),
      p = await projects.create(ctx.user.id)
    ids.push(p.id)
    const old = cfg.env.FREE_QUOTA_MB
    cfg.env.FREE_QUOTA_MB = 1
    try {
      const results = await Promise.allSettled(
        [ctx.project.id, p.id].map((id) =>
          limits.reserve({ userId: ctx.user.id, projectId: id, category: 'attachments', key: 'test:' + id }, 700_000),
        ),
      )
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<string>
      await limits.settle(winner.value, true)
      expect((await limits.usage(ctx.user.id)).used).toBe(700_000)
      const replacement = await limits
        .reserve(
          { userId: ctx.user.id, projectId: ctx.project.id, category: 'attachments', key: 'test:' + ctx.project.id },
          100_000,
        )
        .catch(() => null)
      if (replacement) await limits.settle(replacement, false)
      expect((await limits.usage(ctx.user.id)).reserved).toBe(0)
    } finally {
      cfg.env.FREE_QUOTA_MB = old
    }
  })
  test('source byte accounting supports replacement, binary files and quota rollback', async () => {
    const ctx = await fixture('free'),
      old = cfg.env.FREE_QUOTA_MB
    cfg.env.FREE_QUOTA_MB = 1
    try {
      await apps.saveSnapshot(ctx.project.id, [{ path: 'binary.png', content: 'AP+A', encoding: 'base64' }])
      expect((await limits.usage(ctx.user.id)).categories.source).toBe(3)
      await expect(
        apps.saveSnapshot(ctx.project.id, [{ path: 'big.txt', content: 'x'.repeat(1_100_000) }]),
      ).rejects.toThrow('quota')
      expect((await apps.loadSnapshot(ctx.project.id))?.[0].path).toBe('binary.png')
      await apps.saveSnapshot(ctx.project.id, [{ path: 'a.txt', content: 'x' }])
      expect((await limits.usage(ctx.user.id)).categories.source).toBe(1)
    } finally {
      cfg.env.FREE_QUOTA_MB = old
    }
  })
  test('published slots are reserved atomically and failure frees the slot', async () => {
    const ctx = await fixture('free'),
      b = await apps.create(ctx.project.id, 'second')
    const results = await Promise.allSettled([ctx.project.id, b.id].map((id) => limits.reservePublish(ctx.user.id, id)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const id of [ctx.project.id, b.id]) await limits.releasePublish(id)
    await limits.reservePublish(ctx.user.id, b.id)
    await limits.releasePublish(b.id)
  })
  test('read-only credentials isolate tenants, future tables and role escalation; expiry disconnects sessions', async () => {
    const ctx = await fixture(),
      other = await fixture()
    await pool.query(`CREATE TABLE p_${ctx.project.id}.items(id int); INSERT INTO p_${ctx.project.id}.items VALUES(7)`)
    await pool.query(`CREATE TABLE p_${other.project.id}.secret(id int)`)
    const info = await direct.create(ctx),
      conn = new URL(url!)
    conn.username = info.username
    conn.password = info.password
    const client = new pg.Client({ connectionString: conn.toString() })
    client.on('error', () => {})
    await client.connect()
    try {
      expect((await client.query('SELECT * FROM items')).rows).toEqual([{ id: 7 }])
      await client.query('SET default_transaction_read_only=off')
      await expect(client.query('INSERT INTO items VALUES(8)')).rejects.toThrow()
      await expect(client.query(`SELECT * FROM p_${other.project.id}.secret`)).rejects.toThrow()
      await expect(client.query(`SET ROLE ws_${ctx.project.id}`)).rejects.toThrow()
      await pool.query(`CREATE TABLE p_${ctx.project.id}.future(id int)`)
      expect((await client.query('SELECT * FROM future')).rows).toEqual([])
      const reset = await direct.create(ctx)
      expect(reset.password).not.toBe(info.password)
      const again = new pg.Client({ connectionString: conn.toString() })
      await expect(again.connect()).rejects.toThrow()
      await again.end().catch(() => {})
      conn.password = reset.password
      const active = new pg.Client({ connectionString: conn.toString() })
      active.on('error', () => {})
      await active.connect()
      await pool.query(
        `UPDATE public."user" SET stripe_subscription_id='sub_expired',stripe_paid_until=now()-interval '1 second' WHERE id=$1`,
        [ctx.user.id],
      )
      await direct.reconcile(ctx.user.id)
      await expect(active.query('SELECT 1')).rejects.toThrow()
      await active.end().catch(() => {})
      const denied = new pg.Client({ connectionString: conn.toString() })
      await expect(denied.connect()).rejects.toThrow()
      await denied.end().catch(() => {})
    } finally {
      await client.end().catch(() => {})
    }
  })
  test('over-quota SQL writes roll back while reads and cleanup remain available', async () => {
    const ctx = await fixture('free'),
      role = await roles.ensureWorkspaceRole(ctx.project.id)
    await pool.query(`CREATE TABLE p_${ctx.project.id}.items(id int);INSERT INTO p_${ctx.project.id}.items VALUES(1)`)
    const old = cfg.env.FREE_QUOTA_MB
    cfg.env.FREE_QUOTA_MB = 0
    try {
      await expect(sql.run(role, 'p_' + ctx.project.id, 'INSERT INTO items VALUES(2)')).rejects.toThrow('quota')
      expect((await sql.run(role, 'p_' + ctx.project.id, 'SELECT * FROM items')).rows).toHaveLength(1)
      await sql.run(role, 'p_' + ctx.project.id, 'DELETE FROM items')
      expect((await sql.run(role, 'p_' + ctx.project.id, 'SELECT * FROM items')).rows).toHaveLength(0)
    } finally {
      cfg.env.FREE_QUOTA_MB = old
    }
  })
  test('full SQL restores data; ZIP preserves binary files and excludes secret files', async () => {
    const ctx = await fixture()
    await pool.query(
      `CREATE TABLE p_${ctx.project.id}.sample(id int,label text);INSERT INTO p_${ctx.project.id}.sample VALUES(1,'你好')`,
    )
    const dump = await bytes(await exports.sql(ctx))
    expect(dump.toString()).toContain('COPY')
    expect(dump.toString()).not.toContain('CREATE TABLE public.')
    const restore = 'restore_' + randomUUID().replaceAll('-', '')
    const connection = new URL(url!)
    connection.pathname = '/' + restore
    await pool.query(`CREATE DATABASE "${restore}"`)
    try {
      const child = spawn(process.env.TEST_PSQL_PATH ?? 'psql', [], {
        env: {
          ...process.env,
          PGHOST: connection.hostname,
          PGPORT: connection.port,
          PGUSER: decodeURIComponent(connection.username),
          PGPASSWORD: decodeURIComponent(connection.password),
          PGDATABASE: restore,
        },
        stdio: ['pipe', 'ignore', 'pipe'],
      })
      child.stderr.resume()
      child.stdin.end(dump)
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('close', resolve)
        child.on('error', reject)
      })
      expect(code).toBe(0)
      const restored = new pg.Pool({ connectionString: connection.toString() })
      expect((await restored.query(`SELECT * FROM p_${ctx.project.id}.sample`)).rows).toEqual([
        { id: 1, label: '你好' },
      ])
      await restored.end()
    } finally {
      await pool.query(`DROP DATABASE "${restore}" WITH (FORCE)`)
    }
    await apps.saveSnapshot(ctx.project.id, [
      { path: 'bun.lock', content: 'lock' },
      { path: 'public/a.bin', encoding: 'base64', content: 'AP+A' },
      { path: '.env', content: 'SECRET=do-not-export' },
      { path: 'src/main.ts', content: 'export {}' },
    ])
    const zip = await bytes(await exports.source(ctx)),
      file = '/tmp/lovbase-export-' + randomUUID() + '.zip'
    await writeFile(file, zip)
    try {
      const result = Bun.spawnSync(['unzip', '-p', file, `apps/${ctx.project.id}/public/a.bin`])
      expect([...result.stdout]).toEqual([0, 255, 128])
      const names = Bun.spawnSync(['unzip', '-Z1', file]).stdout.toString()
      expect(names).toContain('bun.lock')
      expect(names).not.toContain('.env')
    } finally {
      await unlink(file)
    }
  }, 30000)
  test('legacy source backfill is idempotent and old bytes count before the manifest exists', async () => {
    const ctx = await fixture()
    await pool.query('INSERT INTO public.lb_app_files(app_id,files) VALUES($1,$2)', [
      ctx.project.id,
      JSON.stringify([
        { path: 'old.txt', content: '你好' },
        { path: 'binary.bin', content: 'AP+A', encoding: 'base64' },
      ]),
    ])
    expect((await limits.usage(ctx.user.id)).categories.source).toBe(9)
    const reconciler = new StorageReconciler(pool, schema, cfg, { enabled: false } as any, limits)
    await reconciler.reconcile()
    await reconciler.reconcile()
    const orphanInventory = new StorageReconciler(
      pool,
      schema,
      cfg,
      {
        enabled: true,
        listObjects: async () => [{ key: 'public/avatar/deleted-account/old.png', size: 100 }],
      } as any,
      limits,
    )
    await orphanInventory.reconcile()
    expect((await limits.usage(ctx.user.id)).categories.source).toBe(9)
    await apps.saveSnapshot(ctx.project.id, [{ path: 'smaller.txt', content: 'x' }])
    expect((await limits.usage(ctx.user.id)).categories.source).toBe(1)
  })
  test('inline attachment cleanup releases capacity without object storage', async () => {
    const ctx = await fixture()
    const content = Buffer.from('inline attachment')
    const key = chatAttachmentKey(ctx.project.id, createHash('sha256').update(content).digest('hex'), 'note.txt')
    const storage = new StorageService(cfg, limits)
    await storage.inline(ctx.project.id, key, content.length)
    await pool.query('INSERT INTO public.lb_chat(project_id,messages) VALUES($1,$2)', [
      ctx.project.id,
      JSON.stringify([
        {
          id: 'inline-message',
          role: 'user',
          parts: [{ type: 'file', filename: 'note.txt', url: 'data:text/plain;base64,' + content.toString('base64') }],
        },
      ]),
    ])
    const reconciler = new StorageReconciler(pool, schema, cfg, { enabled: false } as any, limits)
    await reconciler.reconcile()
    await reconciler.reconcile()
    expect((await limits.usage(ctx.user.id)).categories.attachments).toBe(content.length)
    await pool.query("UPDATE public.lb_chat SET messages='[]'::jsonb WHERE project_id=$1", [ctx.project.id])
    await reconciler.reconcile()
    expect((await limits.usage(ctx.user.id)).categories.attachments ?? 0).toBe(0)
  })
  test('a downgrade between storage reservation and commit is rechecked and can be aborted', async () => {
    const ctx = await fixture(),
      old = cfg.env.FREE_QUOTA_MB
    cfg.env.FREE_QUOTA_MB = 1
    try {
      const id = await limits.reserve(
        { userId: ctx.user.id, projectId: ctx.project.id, category: 'attachments', key: 'expire:' + ctx.project.id },
        1_100_000,
      )
      await pool.query(
        `UPDATE public."user" SET stripe_subscription_id='sub_expired',stripe_paid_until=now()-interval '1 second' WHERE id=$1`,
        [ctx.user.id],
      )
      await expect(limits.settle(id, true)).rejects.toThrow('quota')
      await limits.settle(id, false)
      expect((await limits.usage(ctx.user.id)).reserved).toBe(0)
    } finally {
      cfg.env.FREE_QUOTA_MB = old
    }
  })
  test('all model entrypoints persist streamed, JSON, missing and BYOK usage without duplicate recovery charges', async () => {
    const ctx = await fixture(),
      runId = randomUUID(),
      requests: any[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const body = await req.json()
        requests.push(body)
        if (req.url.endsWith('/missing')) return Response.json({ choices: [] })
        if (req.url.endsWith('/fail')) return new Response('failed', { status: 503 })
        const data = {
          usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 100 } },
        }
        return body.stream
          ? new Response('data: ' + JSON.stringify(data) + '\n\ndata: [DONE]\n\n', {
              headers: { 'content-type': 'text/event-stream' },
            })
          : Response.json(data)
      },
    })
    try {
      const rates = new RatesService({ get: async () => null } as any),
        meter = new ModelMeterService(pool, credits, rates, limits)
      const config = { model: 'gpt-5.6-sol', baseURL: String(server.url), apiKey: 'test', source: 'platform' as const }
      const call = meter.fetchFor(config, { userId: ctx.user.id, projectId: ctx.project.id, runId })
      for (const [path, stream] of [
        ['json', false],
        ['stream', true],
        ['missing', false],
        ['fail', false],
      ] as const)
        await (await call(new URL(path, server.url), { method: 'POST', body: JSON.stringify({ stream }) })).text()
      const own = meter.fetchFor(
        { ...config, source: 'user' },
        { userId: ctx.user.id, projectId: ctx.project.id, runId },
      )
      await (await own(new URL('json', server.url), { method: 'POST', body: '{}' })).text()
      const ledger = (
        await pool.query('SELECT * FROM public.lb_model_requests WHERE run_id=$1 ORDER BY created_at', [runId])
      ).rows
      expect(ledger).toHaveLength(5)
      expect(ledger.filter((r) => r.status === 'charged')).toHaveLength(3)
      expect(ledger.filter((r) => r.status === 'usage_missing')).toHaveLength(2)
      expect(ledger.find((r) => r.byok).credits).toBe(0)
      expect(ledger[0].usage.cachedTokens).toBe(100)
      expect(requests[1].stream_options.include_usage).toBe(true)
      const before = (await credits.balanceOf(ctx.user.id)).used
      const recovery = new GenerationService(pool, cfg, credits, rates, {} as any, {} as any, limits, meter)
      await recovery.reconcile()
      await recovery.reconcile()
      expect((await credits.balanceOf(ctx.user.id)).used).toBe(before)
      await pool.query(
        `UPDATE public."user" SET stripe_subscription_id='sub_expired',stripe_paid_until=now()-interval '1 second' WHERE id=$1`,
        [ctx.user.id],
      )
      await expect(own(new URL('json', server.url), { method: 'POST', body: '{}' })).rejects.toThrow('BYOK')
    } finally {
      await server.stop(true)
    }
  })
  test('model and container reconciliation debit wallets once, including concurrent retries', async () => {
    const ctx = await fixture()
    await pool.query('UPDATE public."user" SET credits_bonus=100 WHERE id=$1', [ctx.user.id])
    const charge = {
      kind: 'build_app' as const,
      idempotencyKey: 'test:' + randomUUID(),
      credits: 550,
      projectId: ctx.project.id,
    }
    await Promise.all([credits.charge(ctx.user.id, charge), credits.charge(ctx.user.id, charge)])
    expect((await credits.balanceOf(ctx.user.id)).bonus).toBe(50)
    const runId = randomUUID(),
      requestId = randomUUID()
    await pool.query(
      `INSERT INTO public.lb_generation_runs(id,user_id,project_id,app_id,model,tier,byok,status,container_ms,container_credits,container_cost)
      VALUES($1,$2,$3,$3,'test','standard',false,'finished',1000,2,0.01)`,
      [runId, ctx.user.id, ctx.project.id],
    )
    await pool.query(
      `INSERT INTO public.lb_model_requests(id,run_id,user_id,project_id,model,byok,usage,credits,cost_usd,status)
      VALUES($1,$2,$3,$4,'test',false,'{"inTokens":3,"outTokens":4}',3,0.01,'measured')`,
      [requestId, runId, ctx.user.id, ctx.project.id],
    )
    const meter = new GenerationService(pool, cfg, credits, {} as any, {} as any, {} as any, limits, {} as any)
    await Promise.all([meter.reconcile(), meter.reconcile()])
    await meter.reconcile()
    expect((await credits.balanceOf(ctx.user.id)).bonus).toBe(45)
  })
})
