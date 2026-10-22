import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { effectivePlan } from '@lovbase/core/billing'
import { planOf } from '@lovbase/core/plans'
import { ConfigService } from '../../config/config.service'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { QuotaExceeded, PlanLimit, NotFound, Forbidden, DomainError } from '../../common/errors'

type Db = Pick<pg.PoolClient, 'query'>
export type StorageScope = { userId: string; projectId?: string; category: string; key: string }

/** Account-wide entitlements. No caller-supplied plan is trusted. */
@Injectable()
export class LimitsService {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly cfg: ConfigService,
    private readonly schema: SchemaService,
  ) {}
  get ratePerMin() {
    return this.cfg.env.WS_RATE_PER_MIN
  }
  allowRequest(workspaceId: string, cost = 1): boolean {
    const now = Date.now(),
      rate = this.ratePerMin
    const b = this.buckets.get(workspaceId) ?? { tokens: rate, at: now }
    b.tokens = Math.min(rate, b.tokens + ((now - b.at) / 60000) * rate)
    b.at = now
    this.buckets.set(workspaceId, b)
    if (b.tokens < cost) return false
    b.tokens -= cost
    return true
  }
  async plan(userId: string, db: Db = this.pool) {
    const r = await db.query('SELECT * FROM public."user" WHERE id=$1', [userId])
    if (!r.rows[0]) throw new NotFound('Account not found')
    return planOf(effectivePlan(r.rows[0]))
  }
  async owner(projectId: string, db: Db = this.pool): Promise<string> {
    const r = await db.query('SELECT owner_id FROM public.lb_projects WHERE id=$1', [projectId])
    if (!r.rows[0]?.owner_id) throw new NotFound('Project not found')
    return r.rows[0].owner_id
  }
  async lock(db: Db, userId: string) {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['storage:' + userId])
  }
  async transaction<T>(userId: string, fn: (db: pg.PoolClient) => Promise<T>, inventory = false): Promise<T> {
    await this.schema.ready()
    const db = await this.pool.connect()
    try {
      await db.query('BEGIN')
      await this.lock(db, userId)
      if (!inventory) await this.assertStorageReady(db)
      const result = await fn(db)
      await db.query('COMMIT')
      return result
    } catch (e) {
      await db.query('ROLLBACK')
      throw e
    } finally {
      db.release()
    }
  }
  async schemaBytes(projectId: string, db: Db = this.pool): Promise<number> {
    const r = await db.query(
      `SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::bigint AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','m')`,
      ['p_' + projectId],
    )
    return Number(r.rows[0].bytes)
  }
  async usage(userId: string, db: Db = this.pool) {
    const plan = await this.plan(userId, db)
    const r = await db.query(
      `SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::bigint bytes
      FROM public.lb_projects p JOIN pg_namespace n ON n.nspname='p_'||p.id
      JOIN pg_class c ON c.relnamespace=n.oid AND c.relkind IN ('r','m') WHERE p.owner_id=$1`,
      [userId],
    )
    const database = Number(r.rows[0].bytes)
    const f = await db.query(
      'SELECT category, sum(bytes)::bigint bytes FROM public.lb_storage_files WHERE user_id=$1 GROUP BY category',
      [userId],
    )
    const categories: Record<string, number> = { database }
    for (const row of f.rows) categories[row.category] = Number(row.bytes)
    // Old snapshots count immediately, before the incremental manifest backfill reaches them.
    const legacy = await db.query(
      `SELECT coalesce(sum(CASE WHEN f.value->>'encoding'='base64'
      THEN octet_length(decode(f.value->>'content','base64')) ELSE octet_length(f.value->>'content') END),0)::bigint bytes
      FROM public.lb_apps a JOIN public.lb_projects p ON p.id=a.project_id
      JOIN public.lb_app_files s ON s.app_id=a.id CROSS JOIN LATERAL jsonb_array_elements(s.files) f(value)
      WHERE p.owner_id=$1 AND NOT EXISTS(SELECT 1 FROM public.lb_storage_files m WHERE m.key='source:'||a.id)`,
      [userId],
    )
    categories.source = (categories.source ?? 0) + Number(legacy.rows[0].bytes)
    const imports = await db.query(
      'SELECT coalesce(sum(octet_length(snapshot::text)),0)::bigint bytes FROM public.lb_sheet_imports WHERE user_id=$1',
      [userId],
    )
    categories.imports = Number(imports.rows[0].bytes)
    const pending = await db.query(
      'SELECT coalesce(sum(greatest(delta,0)),0)::bigint bytes FROM public.lb_storage_reservations WHERE user_id=$1 AND expires_at>now()',
      [userId],
    )
    const count = await db.query('SELECT count(*)::int n FROM public.lb_projects WHERE owner_id=$1', [userId])
    const used = Object.values(categories).reduce((a, b) => a + b, 0)
    const limit = (this.cfg.quotaMb[plan.id] ?? plan.storageMb) * 1024 * 1024
    return {
      plan: plan.id,
      projects: count.rows[0].n,
      projectLimit: plan.projects,
      used,
      reserved: Number(pending.rows[0].bytes),
      limit,
      categories,
    }
  }
  async assertAccount(userId: string, db: Db = this.pool, extra = 0) {
    await this.assertStorageReady(db)
    const u = await this.usage(userId, db)
    if (u.projects > u.projectLimit)
      throw new PlanLimit('Project limit exceeded. Delete projects or upgrade before making further changes.')
    if (u.used + u.reserved + extra > u.limit)
      throw new QuotaExceeded('Account storage quota reached. Delete data or upgrade.')
  }
  private async assertStorageReady(db: Db) {
    if (!this.cfg.isProduction) return
    const control = await db.query('SELECT paused,storage_ready FROM public.lb_billing_control WHERE id=1')
    if (control.rows[0]?.paused || !control.rows[0]?.storage_ready)
      throw new DomainError('Maintenance: account writes are paused until storage inventory is verified')
  }
  async assertWithinQuota(projectId: string, _plan?: string) {
    await this.assertAccount(await this.owner(projectId))
  }
  /** Called inside the same transaction as every tenant database mutation. */
  async beforeWrite(db: Db, projectId: string, cleanup = false) {
    const project = await db.query('SELECT read_only FROM public.lb_projects WHERE id=$1', [projectId])
    if (project.rows[0]?.read_only) throw new Forbidden('read_only')
    const userId = await this.owner(projectId, db)
    await this.lock(db, userId)
    if (!cleanup) await this.assertAccount(userId, db)
    return userId
  }
  async reserve(scope: StorageScope, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid storage size')
    const id = randomUUID()
    await this.transaction(scope.userId, async (db) => {
      await db.query('DELETE FROM public.lb_storage_reservations WHERE expires_at<=now()')
      const old = await db.query('SELECT bytes FROM public.lb_storage_files WHERE key=$1', [scope.key])
      const delta = bytes - Number(old.rows[0]?.bytes ?? 0)
      if (delta > 0) await this.assertAccount(scope.userId, db, delta)
      await db.query(
        `INSERT INTO public.lb_storage_reservations(id,key,user_id,project_id,category,bytes,delta,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 hour')`,
        [id, scope.key, scope.userId, scope.projectId ?? null, scope.category, bytes, delta],
      )
    })
    return id
  }
  async settle(id: string, success: boolean) {
    const found = await this.pool.query('SELECT user_id FROM public.lb_storage_reservations WHERE id=$1', [id])
    if (!found.rows[0]) return
    await this.transaction(found.rows[0].user_id, async (db) => {
      const r = await db.query('DELETE FROM public.lb_storage_reservations WHERE id=$1 RETURNING *', [id])
      const row = r.rows[0]
      if (!row || !success) return
      await db.query(
        `INSERT INTO public.lb_storage_files(key,user_id,project_id,category,bytes) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(key) DO UPDATE SET bytes=EXCLUDED.bytes, updated_at=now()`,
        [row.key, row.user_id, row.project_id, row.category, row.bytes],
      )
      if (Number(row.delta) > 0) await this.assertAccount(row.user_id, db)
    })
  }
  async forget(key: string) {
    await this.pool.query('DELETE FROM public.lb_storage_files WHERE key=$1', [key])
  }
  async reservePublish(userId: string, appId: string) {
    await this.transaction(userId, async (db) => {
      const p = await this.plan(userId, db)
      await this.assertAccount(userId, db)
      await db.query('DELETE FROM public.lb_publish_reservations WHERE expires_at<=now()')
      const r = await db.query(
        `SELECT count(*)::int n FROM public.lb_apps a JOIN public.lb_projects p ON p.id=a.project_id
        WHERE p.owner_id=$1 AND a.published_at IS NOT NULL`,
        [userId],
      )
      const n = await db.query(
        'SELECT count(*)::int n FROM public.lb_publish_reservations WHERE user_id=$1 AND app_id<>$2',
        [userId, appId],
      )
      const app = await db.query('SELECT published_at FROM public.lb_apps WHERE id=$1', [appId])
      if (r.rows[0].n > p.publishedApps || (!app.rows[0]?.published_at && r.rows[0].n + n.rows[0].n >= p.publishedApps))
        throw new PlanLimit('Published app limit reached')
      await db.query(
        `INSERT INTO public.lb_publish_reservations(app_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')
        ON CONFLICT(app_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
        [appId, userId],
      )
    })
  }
  async sandboxQuota(d: {
    appId: string
    category: 'build' | 'published'
    phase: 'reserve' | 'commit' | 'abort'
    bytes?: number
    reservation?: string
  }) {
    const r = await this.pool.query(
      'SELECT p.owner_id,a.project_id FROM public.lb_apps a JOIN public.lb_projects p ON p.id=a.project_id WHERE a.id=$1',
      [d.appId],
    )
    if (!r.rows[0]) throw new NotFound('App not found')
    const scope = {
      userId: r.rows[0].owner_id,
      projectId: r.rows[0].project_id,
      category: d.category,
      key: `static:${d.appId}:${d.category}`,
    }
    if (d.phase === 'reserve') return { reservation: await this.reserve(scope, d.bytes ?? 0) }
    const found = await this.pool.query('SELECT id FROM public.lb_storage_reservations WHERE id=$1 AND key=$2', [
      d.reservation,
      scope.key,
    ])
    if (found.rowCount) await this.settle(d.reservation!, d.phase === 'commit')
    return { ok: true }
  }
  async releasePublish(appId: string) {
    await this.pool.query('DELETE FROM public.lb_publish_reservations WHERE app_id=$1', [appId])
  }
}
