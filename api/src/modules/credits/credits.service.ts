import { Injectable, Logger } from '@nestjs/common'
import type pg from 'pg'
import { CREDIT_COST, planOf, type CreditKind, type Plan } from '@lovbase/core/plans'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { DomainError } from '../../common/errors'

// Credit meter. One agent turn costs `message`; a Boris build costs `build_app`.
// The ledger is append-only: the balance is the plan's monthly allowance plus admin grants,
// minus everything spent since the current period started. Nothing is ever mutated in place,
// so a user's history stays auditable and admin grants never race with spending.

export type Balance = {
  plan: Plan; included: number; bonus: number; used: number; left: number; periodStart: string; periodEnd: string
}
export type UsageRow = { day: string; kind: string; credits: number; turns: number }
export type TopUser = { userId: string; email: string; name: string; plan: string; credits: number; turns: number; lastAt: string }
export type PlatformStats = { users: number; paying: number; creditsToday: number; credits30d: number; turns30d: number; builds30d: number }

export class OutOfCredits extends DomainError {
  readonly status = 402
  constructor(public readonly balance: Balance) { super('额度已用完') }
}

/** Start of the user's current billing period: their subscription anchor, else the calendar month. */
function periodOf(row: { period_start: string | null }): { start: Date; end: Date } {
  const now = new Date()
  const anchor = row.period_start ? new Date(row.period_start) : null
  if (!anchor || Number.isNaN(anchor.getTime())) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    return { start, end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) }
  }
  // Roll the anchor forward month by month until it covers now.
  const start = new Date(anchor)
  while (start.getTime() <= now.getTime()) start.setUTCMonth(start.getUTCMonth() + 1)
  start.setUTCMonth(start.getUTCMonth() - 1)
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  return { start, end }
}

@Injectable()
export class CreditsService {
  private readonly log = new Logger('credits')

  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService) {}

  async balanceOf(userId: string): Promise<Balance> {
    await this.schema.ready()
    const u = await this.pool.query(`SELECT plan, period_start, credits_bonus FROM public."user" WHERE id = $1`, [userId])
    const row = u.rows[0] ?? { plan: 'free', period_start: null, credits_bonus: 0 }
    const { start, end } = periodOf(row)
    const spent = await this.pool.query(
      `SELECT coalesce(sum(credits), 0)::int AS used FROM public.lb_credits WHERE user_id = $1 AND created_at >= $2`,
      [userId, start.toISOString()])
    const included = planOf(row.plan).credits
    const bonus = row.credits_bonus ?? 0
    const used = spent.rows[0].used as number
    return {
      plan: row.plan as Plan, included, bonus, used,
      left: Math.max(0, included + bonus - used),
      periodStart: start.toISOString(), periodEnd: end.toISOString(),
    }
  }

  /** Throws OutOfCredits when the turn cannot be paid for. Call before starting work. */
  async assert(userId: string, kind: CreditKind): Promise<Balance> {
    const b = await this.balanceOf(userId)
    if (b.left < CREDIT_COST[kind]) throw new OutOfCredits(b)
    return b
  }

  /** Record consumption. Never throws into the caller's path: a missed ledger row must not fail a turn. */
  async spend(userId: string, kind: CreditKind, meta: { projectId?: string; model?: string; note?: string } = {}) {
    try {
      await this.pool.query(
        `INSERT INTO public.lb_credits (user_id, project_id, kind, credits, model, note) VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, meta.projectId ?? null, kind, CREDIT_COST[kind], meta.model ?? null, meta.note ?? null])
    } catch (err) {
      this.log.error(`ledger write failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Per-day usage for one user, for the account page and the admin console. */
  async usageOf(userId: string, days = 30): Promise<UsageRow[]> {
    await this.schema.ready()
    const r = await this.pool.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, kind,
              sum(credits)::int AS credits, count(*)::int AS turns
         FROM public.lb_credits
        WHERE user_id = $1 AND created_at > now() - ($2 || ' days')::interval
        GROUP BY 1, 2 ORDER BY 1 DESC`, [userId, String(days)])
    return r.rows as UsageRow[]
  }

  /** Platform-wide consumption leaderboard for the admin console. */
  async topConsumers(days = 30, limit = 50): Promise<TopUser[]> {
    await this.schema.ready()
    const r = await this.pool.query(
      `SELECT c.user_id, u.email, u.name, u.plan, sum(c.credits)::int AS credits, count(*)::int AS turns,
              max(c.created_at) AS last_at
         FROM public.lb_credits c JOIN public."user" u ON u.id = c.user_id
        WHERE c.created_at > now() - ($1 || ' days')::interval
        GROUP BY 1, 2, 3, 4 ORDER BY credits DESC LIMIT $2`, [String(days), limit])
    return r.rows.map((x) => ({
      userId: x.user_id, email: x.email, name: x.name, plan: x.plan, credits: x.credits, turns: x.turns, lastAt: x.last_at,
    }))
  }

  async platformStats(): Promise<PlatformStats> {
    await this.schema.ready()
    const r = await this.pool.query(`
      SELECT (SELECT count(*)::int FROM public."user") AS users,
             (SELECT count(*)::int FROM public."user" WHERE plan <> 'free') AS paying,
             (SELECT coalesce(sum(credits), 0)::int FROM public.lb_credits WHERE created_at >= date_trunc('day', now())) AS credits_today,
             (SELECT coalesce(sum(credits), 0)::int FROM public.lb_credits WHERE created_at > now() - interval '30 days') AS credits_30d,
             (SELECT count(*)::int FROM public.lb_credits WHERE created_at > now() - interval '30 days') AS turns_30d,
             (SELECT count(*)::int FROM public.lb_credits WHERE kind = 'build_app' AND created_at > now() - interval '30 days') AS builds_30d`)
    const x = r.rows[0]
    return {
      users: x.users, paying: x.paying, creditsToday: x.credits_today,
      credits30d: x.credits_30d, turns30d: x.turns_30d, builds30d: x.builds_30d,
    }
  }

  /** Admin: hand a user extra credits for the current period (or take them back with a negative amount). */
  async grant(userId: string, amount: number) {
    await this.pool.query(`UPDATE public."user" SET credits_bonus = greatest(0, credits_bonus + $2) WHERE id = $1`, [userId, amount])
  }

  /** Set the plan and anchor the billing period to now. */
  async setPlan(userId: string, plan: Plan, opts: { resetPeriod?: boolean } = {}) {
    await this.pool.query(
      `UPDATE public."user" SET plan = $2, plan_since = now()${opts.resetPeriod ? ', period_start = now(), credits_bonus = 0' : ''} WHERE id = $1`,
      [userId, plan])
  }
}
