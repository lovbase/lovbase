import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { PLANS, type Plan } from '@lovbase/core/plans'
import { ConfigService } from '../../config/config.service'
import { InjectPool } from '../../database/pool.provider'
import { DomainError, NotFound } from '../../common/errors'
import { CreditsService } from '../credits/credits.service'

// Stripe Checkout over plain fetch — no SDK, because the only three calls we make are form posts.
// Everything is env-gated: without STRIPE_SECRET_KEY the app runs in "contact us" mode and the
// pricing CTA records intent instead of charging.

export class BillingDisabled extends DomainError {
  readonly status = 501
  constructor() { super('BILLING_OFF') }
}

@Injectable()
export class BillingService {
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly cfg: ConfigService,
    private readonly credits: CreditsService,
  ) {}

  get enabled() { return this.cfg.billingEnabled }

  private async stripe(path: string, body: Record<string, string>) {
    const r = await fetch(`https://api.stripe.com/v1${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body).toString(),
    })
    const json = (await r.json()) as any
    if (!r.ok) throw new Error(json?.error?.message ?? `Stripe HTTP ${r.status}`)
    return json
  }

  /** Returns a Checkout URL for the plan, creating the customer on first purchase. */
  async checkoutUrl(user: { id: string; email: string }, plan: Plan, yearly: boolean, origin: string) {
    if (!this.enabled) throw new BillingDisabled()
    const price = this.cfg.stripePriceId(plan, yearly)
    if (!price) throw new DomainError(`未配置 ${PLANS[plan].name} 的 Stripe price id`)
    const row = await this.pool.query(`SELECT stripe_customer_id FROM public."user" WHERE id = $1`, [user.id])
    let customer = row.rows[0]?.stripe_customer_id as string | null
    if (!customer) {
      const c = await this.stripe('/customers', { email: user.email, 'metadata[userId]': user.id })
      customer = c.id
      await this.pool.query(`UPDATE public."user" SET stripe_customer_id = $2 WHERE id = $1`, [user.id, customer])
    }
    const s = await this.stripe('/checkout/sessions', {
      mode: 'subscription',
      customer: customer!,
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      success_url: `${origin}/settings?upgraded=${plan}`,
      cancel_url: `${origin}/pricing`,
      'metadata[userId]': user.id,
      'metadata[plan]': plan,
      'subscription_data[metadata][userId]': user.id,
      'subscription_data[metadata][plan]': plan,
      allow_promotion_codes: 'true',
    })
    return s.url as string
  }

  /** Stripe customer portal, so subscribers manage or cancel without us building billing UI. */
  async portalUrl(userId: string, origin: string) {
    if (!this.enabled) throw new BillingDisabled()
    const row = await this.pool.query(`SELECT stripe_customer_id FROM public."user" WHERE id = $1`, [userId])
    const customer = row.rows[0]?.stripe_customer_id
    if (!customer) throw new NotFound('还没有订阅记录')
    const s = await this.stripe('/billing_portal/sessions', { customer, return_url: `${origin}/settings` })
    return s.url as string
  }

  /**
   * Apply a subscription event. Called by the webhook controller.
   * Plan comes from the subscription metadata we set at checkout, so a price id change never
   * silently downgrades anyone.
   */
  async applySubscription(evt: any): Promise<boolean> {
    const type = evt?.type as string
    const obj = evt?.data?.object ?? {}
    const userId = obj?.metadata?.userId
    if (!userId) return false
    if (type === 'checkout.session.completed' || type === 'customer.subscription.created' || type === 'customer.subscription.updated') {
      const plan = (obj?.metadata?.plan ?? 'pro') as Plan
      const active = type === 'checkout.session.completed' || ['active', 'trialing'].includes(obj?.status)
      if (active) {
        await this.credits.setPlan(userId, plan, { resetPeriod: true })
        if (obj?.subscription || obj?.id)
          await this.pool.query(`UPDATE public."user" SET stripe_subscription_id = $2 WHERE id = $1`, [userId, obj.subscription ?? obj.id])
        return true
      }
    }
    if (type === 'customer.subscription.deleted') {
      await this.credits.setPlan(userId, 'free', { resetPeriod: true })
      await this.pool.query(`UPDATE public."user" SET stripe_subscription_id = NULL WHERE id = $1`, [userId])
      return true
    }
    return false
  }

  /** Verifies Stripe's `t=…,v1=…` signature header (HMAC-SHA256 over `t.payload`). */
  async verifySignature(payload: string, header: string | null, secret: string): Promise<boolean> {
    if (!header) return false
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]))
    const t = parts.t, v1 = parts.v1
    if (!t || !v1) return false
    if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`))
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
    // constant-time compare
    if (hex.length !== v1.length) return false
    let diff = 0
    for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i)
    return diff === 0
  }
}
