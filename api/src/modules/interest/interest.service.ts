import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { randomId } from '../../common/ids'

/**
 * Who reached for a paid thing before there was anything to pay with.
 *
 * Payments are not switched on, so every upgrade and credit button is a door that does not open.
 * That is worth having anyway — it is the only evidence that the price is wrong or right — but the
 * evidence has to be somewhere it can be read. It was going into the activity log of the user's
 * first project, which is neither queryable nor complete: someone who signed up, saw the pricing
 * and clicked before creating a project had no project to log against, and their click, the
 * purest signal of the lot, was dropped.
 */
export type Intent = {
  id: string
  user_id: string | null
  /** 'plan' or 'pack' — what kind of thing they reached for. */
  kind: string
  /** The plan or pack id, or '' when the click named nothing in particular. */
  target: string
  /** Where in the product the click happened. */
  source: string
  created_at: string
}

export type IntentRow = Intent & { email: string | null; plan: string | null }

@Injectable()
export class InterestService {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService) {}

  /** Never throws into the caller: a lost row must not turn a button into an error. */
  async record(userId: string | null, i: { kind: string; target?: string; source: string }) {
    try {
      await this.schema.ready()
      await this.pool.query(
        `INSERT INTO public.lb_interest (id, user_id, kind, target, source) VALUES ($1, $2, $3, $4, $5)`,
        ['i' + randomId(11), userId, i.kind, i.target ?? '', i.source])
    } catch { /* the signal is nice to have; the click is not worth failing over */ }
  }

  /** Most recent first, with the account behind each click. */
  async recent(limit = 100): Promise<IntentRow[]> {
    await this.schema.ready()
    const r = await this.pool.query(
      `SELECT i.*, u.email, u.plan
         FROM public.lb_interest i
         LEFT JOIN public."user" u ON u.id = i.user_id
        ORDER BY i.created_at DESC
        LIMIT $1`, [limit])
    return r.rows as IntentRow[]
  }

  /**
   * One row per thing reached for: how many clicks, and how many distinct people.
   *
   * People, not clicks, is the number that means anything — one person clicking Pro five times in
   * a row is one person who wants Pro, and reading it as five would be the most flattering
   * possible misreading of a fake door.
   */
  async summary(): Promise<{ kind: string; target: string; clicks: number; people: number }[]> {
    await this.schema.ready()
    const r = await this.pool.query(
      `SELECT kind, target, count(*)::int AS clicks, count(DISTINCT user_id)::int AS people
         FROM public.lb_interest
        GROUP BY kind, target
        ORDER BY people DESC, clicks DESC`)
    return r.rows
  }
}
