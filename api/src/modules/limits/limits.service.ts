import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { ConfigService } from '../../config/config.service'
import { InjectPool } from '../../database/pool.provider'
import { schemaFor } from '../roles/roles.service'
import { QuotaExceeded } from '../../common/errors'

// ── Noisy-neighbour guards for the shared cluster ──
// 1. Per-workspace request rate (token bucket, per process).
// 2. Per-workspace storage quota by plan, checked before writes with a short cache.

@Injectable()
export class LimitsService {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  private readonly sizes = new Map<string, { bytes: number; at: number }>()

  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly cfg: ConfigService) {}

  get ratePerMin() { return this.cfg.env.WS_RATE_PER_MIN }

  /** Returns true when the workspace still has budget in the current minute. */
  allowRequest(workspaceId: string, cost = 1): boolean {
    const rate = this.ratePerMin
    const now = Date.now()
    const b = this.buckets.get(workspaceId) ?? { tokens: rate, at: now }
    b.tokens = Math.min(rate, b.tokens + ((now - b.at) / 60_000) * rate)
    b.at = now
    if (b.tokens < cost) { this.buckets.set(workspaceId, b); return false }
    b.tokens -= cost
    this.buckets.set(workspaceId, b)
    return true
  }

  /** Total size of a workspace's schema in bytes (tables + indexes + toast), cached for a minute. */
  async schemaBytes(projectId: string): Promise<number> {
    const hit = this.sizes.get(projectId)
    if (hit && Date.now() - hit.at < 60_000) return hit.bytes
    const r = await this.pool.query(
      `SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint AS bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'm')`, [schemaFor(projectId)])
    const bytes = Number(r.rows[0].bytes)
    this.sizes.set(projectId, { bytes, at: Date.now() })
    return bytes
  }

  async assertWithinQuota(projectId: string, plan: string) {
    const quota = this.cfg.quotaMb
    const mb = quota[plan] ?? quota.free
    const used = await this.schemaBytes(projectId)
    if (used > mb * 1024 * 1024)
      throw new QuotaExceeded(`Storage has reached the plan limit (${Math.round(used / 1024 / 1024)} MB / ${mb} MB). Clean up data or upgrade.`)
  }
}
