import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import type { Plan } from '@lovbase/core/plans'
import { effectivePlan } from '@lovbase/core/billing'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'

export type Account = { isAdmin: boolean; plan: Plan }
export type AccountRow = {
  id: string; email: string; name: string; isAdmin: boolean; plan: Plan; createdAt: string
  projects: number; used: number; bonus: number; periodStart: string | null
}

/** Reads and writes on Better Auth's `user` table plus the columns the platform added to it. */
@Injectable()
export class AccountsService {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService) {}

  async get(userId: string): Promise<Account | null> {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT "isAdmin", plan, stripe_subscription_id, stripe_paid_start, stripe_paid_until FROM public."user" WHERE id = $1`, [userId])
    return r.rows[0] ? { isAdmin: !!r.rows[0].isAdmin, plan: effectivePlan(r.rows[0]) } : null
  }

  /** Only call with an identity already verified by an authentication provider. */
  async identity(userId: string) {
    await this.schema.ready()
    const r = await this.pool.query('SELECT id,email,name,image,"isAdmin",plan,stripe_subscription_id,stripe_paid_start,stripe_paid_until FROM public."user" WHERE id=$1', [userId])
    if (!r.rows[0]) return undefined
    const { stripe_subscription_id: _subscriptionId, stripe_paid_until: _paidUntil, stripe_paid_start: _paidStart, ...user } = r.rows[0]
    return { ...user, plan: effectivePlan(r.rows[0]) } as import('../auth/access.service').SessionUser
  }

  async promoteAdmin(userId: string) {
    await this.pool.query(`UPDATE public."user" SET "isAdmin" = true WHERE id = $1`, [userId])
  }

  async setAdmin(userId: string, isAdmin: boolean) {
    await this.pool.query(`UPDATE public."user" SET "isAdmin" = $2 WHERE id = $1`, [userId, isAdmin])
  }

  async list(): Promise<AccountRow[]> {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT u.id, u.email, u.name, u."isAdmin", u.plan, u."createdAt", u.credits_bonus, u.period_start,
        (SELECT count(*)::int FROM public.lb_projects p WHERE p.owner_id = u.id) AS projects,
        (SELECT coalesce(sum(c.credits), 0)::int FROM public.lb_credits c
          WHERE c.user_id = u.id AND c.created_at >= coalesce(u.period_start, date_trunc('month', now()))) AS used
      FROM public."user" u ORDER BY u."createdAt" DESC`)
    return r.rows.map((x) => ({
      id: x.id, email: x.email, name: x.name, isAdmin: !!x.isAdmin, plan: x.plan, createdAt: x.createdAt,
      projects: x.projects, used: x.used, bonus: x.credits_bonus, periodStart: x.period_start,
    }))
  }
}
