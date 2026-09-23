import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { PLANS, packOf, type Plan } from '@lovbase/core/plans'
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
    if (!price) throw new DomainError(`No Stripe price id configured for the ${PLANS[plan].name} plan`)
    const customer = await this.customerFor(user)
    const s = await this.stripe('/checkout/sessions', {
      mode: 'subscription',
      customer,
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

  /**
   * Returns a Checkout URL for a one-off credit pack.
   *
   * `mode: payment`, not `subscription` — a pack is bought, not subscribed to, and the credits it
   * carries ride in the session metadata so the webhook grants what was sold rather than what the
   * price id happens to be called today.
   */
  async creditCheckoutUrl(user: { id: string; email: string }, packId: string, origin: string) {
    if (!this.enabled) throw new BillingDisabled()
    const pack = packOf(packId)
    if (!pack) throw new NotFound('No such credit pack')
    const price = this.cfg.stripeCreditPriceId(pack.id)
    if (!price) throw new DomainError(`No Stripe price id configured for the ${pack.credits}-credit pack`)
    const customer = await this.customerFor(user)
    const s = await this.stripe('/checkout/sessions', {
      mode: 'payment',
      customer,
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      success_url: `${origin}/settings?credits=${pack.credits}`,
      cancel_url: `${origin}/settings`,
      'metadata[userId]': user.id,
      'metadata[pack]': pack.id,
      'metadata[credits]': String(pack.credits),
      allow_promotion_codes: 'true',
    })
    return s.url as string
  }

  /** The Stripe customer for this user, created on first purchase of anything. */
  private async customerFor(user: { id: string; email: string }): Promise<string> {
    const row = await this.pool.query(`SELECT stripe_customer_id FROM public."user" WHERE id = $1`, [user.id])
    const existing = row.rows[0]?.stripe_customer_id as string | null
    if (existing) return existing
    const c = await this.stripe('/customers', { email: user.email, 'metadata[userId]': user.id })
    await this.pool.query(`UPDATE public."user" SET stripe_customer_id = $2 WHERE id = $1`, [user.id, c.id])
    return c.id as string
  }

  /** Stripe customer portal, so subscribers manage or cancel without us building billing UI. */
  async portalUrl(userId: string, origin: string) {
    if (!this.enabled) throw new BillingDisabled()
    const row = await this.pool.query(`SELECT stripe_customer_id FROM public."user" WHERE id = $1`, [userId])
    const customer = row.rows[0]?.stripe_customer_id
    if (!customer) throw new NotFound('No subscription on record yet')
    const s = await this.stripe('/billing_portal/sessions', { customer, return_url: `${origin}/settings` })
    return s.url as string
  }

  /**
   * Apply a webhook event. Called by the webhook controller.
   *
   * Two things arrive on this endpoint and only the session's `mode` tells them apart: a
   * subscription checkout, which sets the plan, and a one-off pack, which fills the wallet. Both
   * carry what they sold in their metadata, so a price id renamed in the Stripe dashboard never
   * silently changes what a customer gets.
   */
  async apply(evt: any): Promise<boolean> {
    const type = evt?.type as string
    const obj = evt?.data?.object ?? {}
    const userId = obj?.metadata?.userId
    if (!userId) return false
    if (type === 'checkout.session.completed' && obj?.mode === 'payment') {
      const credits = Number(obj?.metadata?.credits ?? 0)
      if (!Number.isFinite(credits) || credits <= 0) return false
      // `obj.id` is the session id: unique per purchase, which is what makes a retried delivery
      // land once. `payment_status` guards the other direction — an unpaid session grants nothing.
      if (obj?.payment_status && obj.payment_status !== 'paid') return false
      return await this.credits.grant(userId, credits, {
        source: 'purchase', ref: obj.id, amountUsd: (obj?.amount_total ?? 0) / 100,
        note: obj?.metadata?.pack ? `pack ${obj.metadata.pack}` : undefined,
      })
    }
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
