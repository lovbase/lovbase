import { JobQueueService } from '../jobs/job-queue.service'
import { DirectDatabaseService } from '../entitlements/direct-database.service'
import { billingReturnPath } from '@lovbase/core/entitlements'
import { Injectable, Logger } from '@nestjs/common'
import { priceMatches, STRIPE_API_VERSION, STRIPE_EVENTS } from './stripe-contract'
import { Stripe } from 'stripe'
import type pg from 'pg'
import { CREDIT_PACKS, PLANS, packOf, type Plan } from '@lovbase/core/plans'
import { ConfigService } from '../../config/config.service'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { DomainError, NotFound } from '../../common/errors'

export class BillingDisabled extends DomainError {
  readonly status = 501
  constructor() { super('Payments are not configured yet') }
}

const idOf = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id
const terminal = new Set(['canceled', 'incomplete_expired'])

@Injectable()
export class BillingService {
  private client: Stripe | undefined
  private identity: Promise<void> | undefined
  private readonly log = new Logger('billing')

  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly cfg: ConfigService,
    private readonly schema: SchemaService,
    private readonly direct: DirectDatabaseService,
    private readonly queues: JobQueueService,
  ) {}

  get enabled() { return this.cfg.billingEnabled }
  private get stripe(): Stripe {
    if (!this.enabled) throw new BillingDisabled()
    return this.client ??= new Stripe(this.cfg.env.STRIPE_SECRET_KEY!, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 20_000 })
  }

  private async assertIdentity() {
    await this.schema.ready()
    const control = await this.pool.query('SELECT paused FROM public.lb_billing_control WHERE id=1')
    if (control.rows[0]?.paused) throw new BillingDisabled()
    this.identity ??= this.stripe.accounts.retrieve(null).then(account => {
      if (account.id !== this.cfg.env.STRIPE_ACCOUNT_ID || (this.cfg.env.STRIPE_MODE === 'live' && !account.charges_enabled))
        throw new DomainError('Stripe account is not ready or does not match configuration')
    }).catch(error => { this.identity = undefined; throw error })
    await this.identity
  }

  private async assertBinding(row: Record<string, any>) {
    await this.assertIdentity()
    if (row.stripe_customer_id && (row.stripe_account_id !== this.cfg.env.STRIPE_ACCOUNT_ID || row.stripe_mode !== this.cfg.env.STRIPE_MODE))
      throw new DomainError('Stripe account/mode mismatch; billing migration is required')
  }

  get availability() {
    return {
      enabled: this.enabled,
      monthly: this.enabled && !!this.cfg.stripePriceId('pro', false),
      yearly: this.enabled && !!this.cfg.stripePriceId('pro', true),
      packs: CREDIT_PACKS.filter(p => this.enabled && this.cfg.stripeCreditPriceId(p.id)).map(p => p.id),
    }
  }

  /** Serialize checkout creation and webhook application for a customer across all web processes. */
  private async withUser<T>(userId: string, fn: (db: pg.PoolClient, row: Record<string, any>) => Promise<T>): Promise<T> {
    await this.schema.ready()
    const db = await this.pool.connect()
    try {
      await db.query('BEGIN')
      const r = await db.query('SELECT * FROM public."user" WHERE id=$1 FOR UPDATE', [userId])
      if (!r.rows[0]) throw new NotFound('Account not found')
      const result = await fn(db, r.rows[0])
      await db.query('COMMIT')
      return result
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {})
      throw error
    } finally { db.release() }
  }

  private async customerFor(db: pg.PoolClient, row: Record<string, any>): Promise<string> {
    await this.assertBinding(row)
    if (row.stripe_customer_id) return row.stripe_customer_id
    const customer = await this.stripe.customers.create(
      { email: row.email, metadata: { userId: row.id } },
      { idempotencyKey: `lovbase-customer-${this.cfg.env.STRIPE_ACCOUNT_ID}-${this.cfg.env.STRIPE_MODE}-${row.id}` },
    )
    await db.query('UPDATE public."user" SET stripe_customer_id=$2,stripe_account_id=$3,stripe_mode=$4 WHERE id=$1', [row.id, customer.id, this.cfg.env.STRIPE_ACCOUNT_ID, this.cfg.env.STRIPE_MODE])
    return customer.id
  }

  /** The frontend price and Stripe's actual charge must agree before we send anyone to pay. */
  private async validatePrice(priceId: string, amount: number, interval?: 'month' | 'year') {
    if (!priceId) throw new DomainError('This payment option is not configured yet')
    const price = await this.stripe.prices.retrieve(priceId)
    if (!priceMatches(price, this.cfg.env.STRIPE_MODE === 'live', Math.round(amount * 100), interval))
      throw new DomainError('Stripe price does not match the advertised price; contact support')
  }

  async checkoutUrl(user: { id: string; email: string }, plan: Plan, yearly: boolean, returnPath?: string) {
    if (plan !== 'pro') throw new DomainError('This plan is not available for self-service purchase')
    const price = this.cfg.stripePriceId(plan, yearly)
    await this.validatePrice(price, yearly ? PLANS.pro.yearlyPrice * 12 : PLANS.pro.price, yearly ? 'year' : 'month')
    return this.createCheckout(user.id, 'subscription', plan, price, yearly, billingReturnPath(returnPath))
  }

  async creditCheckoutUrl(user: { id: string; email: string }, packId: string) {
    const pack = packOf(packId)
    if (!pack) throw new NotFound('No such credit pack')
    const price = this.cfg.stripeCreditPriceId(pack.id)
    await this.validatePrice(price, pack.price)
    return this.createCheckout(user.id, 'payment', pack.id, price, false)
  }

  private async createCheckout(userId: string, mode: 'subscription' | 'payment', target: string, price: string, yearly: boolean, returnPath?: string) {
    return this.withUser(userId, async (db, row) => {
      const customer = await this.customerFor(db, row)
      if (mode === 'subscription') {
        const subscriptions = await this.stripe.subscriptions.list({ customer, status: 'all', limit: 100 })
        if (subscriptions.has_more) throw new DomainError('Contact support to manage your subscriptions')
        if (subscriptions.data.some(s => !terminal.has(s.status))) return this.createPortal(customer)
      }
      const open = await this.stripe.checkout.sessions.list({ customer, status: 'open', limit: 100 })
      if (open.has_more) throw new DomainError('Too many pending payments; contact support')
      const expired = new Set<string>()
      for (const matching of open.data.filter(s => s.mode === mode && s.metadata?.target === target && s.metadata?.yearly === String(yearly) && (s.metadata?.returnPath ?? '') === (returnPath ?? '') && s.url)) {
        const lines = await this.stripe.checkout.sessions.listLineItems(matching.id, { limit: 2 })
        if (!lines.has_more && lines.data.length === 1 && lines.data[0].price?.id === price && lines.data[0].quantity === 1) {
          await this.recordCheckout(db, matching, userId, target, yearly)
          return matching.url!
        }
        await this.stripe.checkout.sessions.expire(matching.id)
        expired.add(matching.id)
      }
      // A user can switch the billing toggle after opening Checkout. Expire the previous
      // subscription session so paying two tabs cannot create two subscriptions.
      if (mode === 'subscription') {
        for (const session of open.data.filter(s => s.mode === 'subscription' && !expired.has(s.id))) await this.stripe.checkout.sessions.expire(session.id)
      }
      const session = await this.stripe.checkout.sessions.create({
        mode, customer, line_items: [{ price, quantity: 1 }], allowed_payment_method_types: ['card'],
        success_url: `${this.cfg.billingOrigin}${returnPath ?? '/settings'}${returnPath?.includes('?') ? '&' : '?'}checkout={CHECKOUT_SESSION_ID}`,
        cancel_url: returnPath ? `${this.cfg.billingOrigin}${returnPath}${returnPath.includes('?') ? '&' : '?'}canceled=1` : mode === 'subscription' ? `${this.cfg.billingOrigin}/pricing?canceled=1` : `${this.cfg.billingOrigin}/settings?canceled=1`,
        metadata: { userId, target, yearly: String(yearly), returnPath: returnPath ?? '' },
        ...(mode === 'subscription' ? { subscription_data: { metadata: { userId, plan: 'pro' } } } : {}),
      })
      if (!session.url) throw new Error('Stripe did not return a Checkout URL')
      await this.recordCheckout(db, session, userId, target, yearly)
      return session.url
    })
  }

  private async recordCheckout(db: pg.PoolClient, session: Stripe.Checkout.Session, userId: string, target: string, yearly: boolean) {
    await db.query(`INSERT INTO public.lb_checkout_sessions(id,user_id,kind,target,yearly)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`, [session.id, userId, session.mode, target, yearly])
  }

  private async createPortal(customer: string) {
    const session = await this.stripe.billingPortal.sessions.create({
      customer, return_url: `${this.cfg.billingOrigin}/settings`,
      ...(this.cfg.env.STRIPE_PORTAL_CONFIGURATION ? { configuration: this.cfg.env.STRIPE_PORTAL_CONFIGURATION } : {}),
    })
    return session.url
  }

  async portalUrl(userId: string) {
    await this.schema.ready()
    const r = await this.pool.query('SELECT stripe_customer_id,stripe_account_id,stripe_mode FROM public."user" WHERE id=$1', [userId])
    if (!r.rows[0]?.stripe_customer_id) throw new NotFound('No billing account yet')
    await this.assertBinding(r.rows[0])
    return this.createPortal(r.rows[0].stripe_customer_id)
  }

  async subscriptionOf(userId: string) {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT stripe_customer_id, stripe_subscription_id, stripe_status, stripe_interval,
      stripe_paid_until, stripe_cancel_at_period_end FROM public."user" WHERE id=$1`, [userId])
    const row = r.rows[0]
    return {
      hasCustomer: !!row?.stripe_customer_id, id: row?.stripe_subscription_id as string | null,
      status: (row?.stripe_status ?? null) as string | null, interval: (row?.stripe_interval ?? null) as 'month' | 'year' | null,
      paidUntil: row?.stripe_paid_until ? new Date(row.stripe_paid_until).toISOString() : null,
      cancelAtPeriodEnd: !!row?.stripe_cancel_at_period_end,
    }
  }

  async checkoutStatus(userId: string, sessionId: string): Promise<'pending' | 'complete' | 'failed'> {
    await this.schema.ready()
    const r = await this.pool.query('SELECT status FROM public.lb_checkout_sessions WHERE id=$1 AND user_id=$2', [sessionId, userId])
    if (!r.rows[0]) throw new NotFound('Payment not found')
    return r.rows[0].status
  }

  async parseWebhook(payload: Buffer, header: string | string[] | undefined): Promise<Stripe.Event> {
    if (!this.cfg.env.STRIPE_WEBHOOK_SECRET) throw new BillingDisabled()
    const event = await this.stripe.webhooks.constructEventAsync(payload, header ?? '', this.cfg.env.STRIPE_WEBHOOK_SECRET)
    if (event.livemode !== (this.cfg.env.STRIPE_MODE === 'live')) throw new DomainError('Webhook mode mismatch')
    return event
  }

  /** Re-fetch current Stripe state rather than applying potentially stale event snapshots. */
  async apply(evt: Stripe.Event): Promise<boolean> {
    if (!this.enabled) throw new BillingDisabled()
    if (evt.livemode !== (this.cfg.env.STRIPE_MODE === 'live')) throw new DomainError('Webhook mode mismatch')
    if (!(STRIPE_EVENTS as readonly string[]).includes(evt.type)) return false
    const checkout = evt.type.startsWith('checkout.session.')
    const subscription = !checkout
    const object = evt.data.object as { id: string; customer?: string | { id: string } | null }
    const customer = idOf(object.customer)
    if (!customer) return false
    await this.schema.ready()
    const account = await this.pool.query('SELECT id FROM public."user" WHERE stripe_customer_id=$1', [customer])
    if (!account.rows[0]) return false
    return this.withUser(account.rows[0].id, async (db, row) => {
      await this.assertBinding(row)
      const inserted = await db.query('INSERT INTO public.lb_billing_events(id,type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id', [evt.id, evt.type])
      if (!inserted.rowCount) return false
      if (checkout) {
        const session = await this.stripe.checkout.sessions.retrieve(object.id)
        if (idOf(session.customer) !== customer || session.metadata?.userId !== row.id) throw new DomainError('Payment customer mismatch')
        const target = session.metadata?.target
        if (!target) throw new DomainError('Missing payment product')
        await this.recordCheckout(db, session, row.id, target, session.metadata?.yearly === 'true')
        if (session.status === 'expired' || (evt.type === 'checkout.session.async_payment_failed' && session.payment_status !== 'paid')) {
          await db.query("UPDATE public.lb_checkout_sessions SET status='failed' WHERE id=$1", [session.id])
        } else if (session.mode === 'payment' && session.payment_status === 'paid') {
          await this.grantPack(db, row.id, session, target)
        }
      }
      if (subscription || checkout) await this.syncSubscription(db, row)
      const pending = await db.query(`SELECT id FROM public.lb_checkout_sessions
        WHERE user_id=$1 AND kind='subscription' AND status='pending' ORDER BY created_at DESC LIMIT 20`, [row.id])
      for (const candidate of pending.rows) {
        const session = await this.stripe.checkout.sessions.retrieve(candidate.id)
        const paid = await db.query('SELECT stripe_subscription_id, stripe_paid_until FROM public."user" WHERE id=$1', [row.id])
        if (session.status === 'complete' && session.payment_status === 'paid'
          && idOf(session.subscription) === paid.rows[0].stripe_subscription_id
          && paid.rows[0].stripe_paid_until && new Date(paid.rows[0].stripe_paid_until) > new Date())
          await db.query("UPDATE public.lb_checkout_sessions SET status='complete' WHERE id=$1", [session.id])
      }
      await db.query(`INSERT INTO public.lb_billing_sync(user_id) VALUES($1)
        ON CONFLICT(user_id) DO UPDATE SET version=lb_billing_sync.version+1,updated_at=now()`, [row.id])
      return true
    }).then(async changed => {
      // The event and the durable work item commit together. Duplicate delivery can retry sync.
      await this.retrySync(account.rows[0].id)
      return changed
    })
  }

  async retrySync(userId?: string) {
    await this.schema.ready()
    const pending = await this.pool.query(`SELECT user_id,version FROM public.lb_billing_sync
      WHERE ($1::text IS NULL OR user_id=$1) ORDER BY updated_at LIMIT 100`, [userId ?? null])
    for (const row of pending.rows) {
      try {
        await this.direct.reconcile(row.user_id)
        await this.queues.refreshPriorities()
        await this.pool.query('DELETE FROM public.lb_billing_sync WHERE user_id=$1 AND version=$2', [row.user_id, row.version])
      } catch {
        await this.pool.query('UPDATE public.lb_billing_sync SET attempts=attempts+1,updated_at=now() WHERE user_id=$1', [row.user_id])
        this.log.warn('Entitlement synchronization pending; durable retry scheduled')
      }
    }
  }

  private async grantPack(db: pg.PoolClient, userId: string, session: Stripe.Checkout.Session, target: string) {
    const pack = packOf(target)
    if (!pack || session.currency !== 'usd') throw new DomainError('Unknown credit pack')
    const lines = await this.stripe.checkout.sessions.listLineItems(session.id, { limit: 2 })
    if (lines.has_more || lines.data.length !== 1 || lines.data[0].quantity !== 1 || lines.data[0].price?.id !== this.cfg.stripeCreditPriceId(pack.id))
      throw new DomainError('Payment product mismatch')
    const inserted = await db.query(`INSERT INTO public.lb_credit_grants(user_id,credits,source,amount_usd,ref,note)
      VALUES($1,$2,'purchase',$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
    [userId, pack.credits, (session.amount_total ?? 0) / 100, session.id, `pack ${pack.id}`])
    if (inserted.rowCount) await db.query('UPDATE public."user" SET credits_bonus=credits_bonus+$2 WHERE id=$1', [userId, pack.credits])
    await db.query("UPDATE public.lb_checkout_sessions SET status='complete' WHERE id=$1", [session.id])
  }

  private async syncSubscription(db: pg.PoolClient, row: Record<string, any>) {
    const subscriptions = await this.stripe.subscriptions.list({ customer: row.stripe_customer_id, status: 'all', limit: 100 })
    if (subscriptions.has_more) throw new DomainError('Too many subscriptions; contact support')
    const supported = subscriptions.data.filter(s => s.items.data.length === 1 && [this.cfg.stripePriceId('pro', false), this.cfg.stripePriceId('pro', true)].includes(s.items.data[0].price.id))
    const candidates = supported.toSorted((a, b) => b.created - a.created)
    let sub = candidates[0]
    if (!sub) return
    let start: Date | null = null, end: Date | null = null
    // A newer abandoned or unpaid Checkout must not replace an older paid subscription.
    for (const candidate of candidates) {
      const price = candidate.items.data[0].price.id
      const invoices = await this.stripe.invoices.list({ customer: row.stripe_customer_id, subscription: candidate.id, status: 'paid', limit: 1 })
      const invoice = invoices.data[0]
      if (invoice?.status === 'paid') {
        const lines = await this.stripe.invoices.listLineItems(invoice.id, { limit: 100 })
        const line = lines.data.find(l => l.pricing?.price_details?.price === price && l.parent?.type === 'subscription_item_details' && !l.parent.subscription_item_details?.proration)
        if (line && line.period.end > line.period.start) {
          start = new Date(line.period.start * 1000)
          end = new Date(line.period.end * 1000)
        }
      }
      // An unpaid renewal never extends the prior term.
      if (row.stripe_subscription_id === candidate.id && row.stripe_paid_until && (!end || new Date(row.stripe_paid_until) > end)) {
        start = row.stripe_paid_start
        end = row.stripe_paid_until
      }
      if (end) { sub = candidate; break }
    }
    const item = sub.items.data[0]
    await db.query(`UPDATE public."user" SET plan='pro', plan_since=coalesce(plan_since,now()),
      stripe_subscription_id=$2, stripe_status=$3, stripe_interval=$4, stripe_paid_start=$5,
      stripe_paid_until=$6, stripe_cancel_at_period_end=$7 WHERE id=$1`,
    [row.id, sub.id, sub.status, item.price.recurring?.interval ?? null, start, end, sub.cancel_at_period_end || !!sub.cancel_at])
  }
}
