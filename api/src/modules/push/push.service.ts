import { Injectable, Logger } from '@nestjs/common'
import type pg from 'pg'
import webpush from 'web-push'
import { createHash } from 'node:crypto'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { ConfigService } from '../../config/config.service'
import type { UserCtx } from '../auth/access.service'

export type PushSubscriptionInput = {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

@Injectable()
export class PushService {
  private readonly log = new Logger('push')
  private readonly configured: boolean

  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService, private readonly cfg: ConfigService) {
    this.configured = !!(cfg.env.VAPID_PUBLIC_KEY && cfg.env.VAPID_PRIVATE_KEY)
    if (this.configured) webpush.setVapidDetails(cfg.env.VAPID_SUBJECT, cfg.env.VAPID_PUBLIC_KEY!, cfg.env.VAPID_PRIVATE_KEY!)
  }

  get publicKey() { return this.configured ? this.cfg.env.VAPID_PUBLIC_KEY! : null }

  async save({ user }: UserCtx, raw: PushSubscriptionInput) {
    if (!this.configured) return { enabled: false }
    if (!raw || typeof raw.endpoint !== 'string' || !/^https:\/\//i.test(raw.endpoint)
      || typeof raw.keys?.p256dh !== 'string' || typeof raw.keys?.auth !== 'string') throw new Error('Invalid push subscription')
    await this.schema.ready()
    const id = 'ps_' + createHash('sha256').update(raw.endpoint).digest('hex').slice(0, 32)
    await this.pool.query(`INSERT INTO public.lb_push_subscriptions(id,user_id,endpoint,p256dh,auth,enabled,updated_at)
      VALUES($1,$2,$3,$4,$5,true,now())
      ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,enabled=true,updated_at=now()`,
      [id, user.id, raw.endpoint, raw.keys.p256dh, raw.keys.auth])
    return { enabled: true }
  }

  async remove({ user }: UserCtx, endpoint: string) {
    if (typeof endpoint !== 'string') return { ok: true }
    await this.schema.ready()
    await this.pool.query('DELETE FROM public.lb_push_subscriptions WHERE user_id=$1 AND endpoint=$2', [user.id, endpoint])
    return { ok: true }
  }

  /** One best-effort attempt per enabled device. Delivery failure never reaches task state. */
  async notify(userId: string, data: { title: string; body: string; url: string; tag: string }) {
    if (!this.configured) return
    try { await this.schema.ready() } catch { return }
    const rows = (await this.pool.query(`SELECT id,endpoint,p256dh,auth FROM public.lb_push_subscriptions WHERE user_id=$1 AND enabled`, [userId])).rows as {
      id: string; endpoint: string; p256dh: string; auth: string
    }[]
    await Promise.all(rows.map(async (row) => {
      try {
        await Promise.race([
          webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(data)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('push timeout')), 8_000)),
        ])
      } catch (error: any) {
        const status = Number(error?.statusCode)
        if (status === 404 || status === 410) await this.pool.query('DELETE FROM public.lb_push_subscriptions WHERE id=$1', [row.id]).catch(() => {})
        else this.log.warn(`push delivery failed (${status || 'error'})`)
      }
    }))
  }
}
