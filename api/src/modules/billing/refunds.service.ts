import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { Stripe } from 'stripe'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { ConfigService } from '../../config/config.service'
import { DomainError } from '../../common/errors'
import { DirectDatabaseService } from '../entitlements/direct-database.service'
import { JobQueueService } from '../jobs/job-queue.service'
import { refreshWallet } from '../credits/wallet'
import { STRIPE_API_VERSION } from './stripe-contract'
import { packOf } from '@lovbase/core/plans'

const idOf = (v: string | { id: string } | null | undefined) => typeof v === 'string' ? v : v?.id
export const REFUND_EVENTS = new Set(['charge.refunded', 'refund.created', 'refund.updated', 'charge.dispute.created', 'charge.dispute.closed'])
class Review extends Error {}
export type ChargeFacts = { charge: Stripe.Charge; refunds: Stripe.Refund[] }

/** Inbox/outbox: no remote call is required to acknowledge a verified refund webhook. */
@Injectable()
export class RefundsService {
  private client?: Stripe
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly cfg: ConfigService,
    private readonly schema: SchemaService,
    private readonly direct: DirectDatabaseService,
    private readonly queues: JobQueueService,
  ) {}

  private get stripe() {
    return this.client ??= new Stripe(this.cfg.env.STRIPE_SECRET_KEY!, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 20_000 })
  }

  private async transaction<T>(fn: (db: pg.PoolClient) => Promise<T>) {
    const db = await this.pool.connect()
    try { await db.query('BEGIN'); const result = await fn(db); await db.query('COMMIT'); return result }
    catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error }
    finally { db.release() }
  }

  private async action(db: pg.PoolClient, key: string, kind: string, userId: string | null, payload: object) {
    await db.query(`INSERT INTO public.lb_billing_actions(action_key,kind,user_id,payload) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT DO NOTHING`, [key, kind, userId, JSON.stringify(payload)])
  }

  async accept(event: Stripe.Event) {
    await this.schema.ready()
    if (!this.cfg.billingEnabled || event.livemode !== (this.cfg.env.STRIPE_MODE === 'live')) throw new DomainError('Webhook mode mismatch')
    if (!REFUND_EVENTS.has(event.type)) return false
    const object = event.data.object as { id: string }
    return this.transaction(async db => {
      const r = await db.query(`INSERT INTO public.lb_billing_events(id,type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id`, [event.id, event.type])
      if (!r.rowCount) return false
      await this.action(db, `event:${event.id}`, 'refund_event', null, {
        id: object.id, type: event.type, account: this.cfg.env.STRIPE_ACCOUNT_ID, mode: this.cfg.env.STRIPE_MODE,
      })
      return true
    }).then(async accepted => {
      // Wake promptly; the persisted inbox and minute reconciliation survive a Redis outage.
      try { await this.queues.maintenance.add('billing.refunds', {}, { jobId: `billing-refunds-${event.id}`, removeOnComplete: true, removeOnFail: 100 }) }
      catch { /* Durable fallback is authoritative. A Redis outage must not reject the receipt. */ }
      return accepted
    })
  }

  /** Paginate: charge.refunds contains only a truncated preview. Ignore pending/failed refunds. */
  async facts(chargeId: string, stripe: Stripe = this.stripe): Promise<ChargeFacts> {
    const charge = await stripe.charges.retrieve(chargeId)
    if (charge.livemode !== (this.cfg.env.STRIPE_MODE === 'live') || !charge.paid || charge.currency !== 'usd' || charge.amount <= 0)
      throw new Review('Charge mode, currency or payment status needs review')
    const refunds: Stripe.Refund[] = []
    let after: string | undefined
    do {
      const page = await stripe.refunds.list({ charge: charge.id, limit: 100, ...(after ? { starting_after: after } : {}) })
      refunds.push(...page.data)
      if (!page.has_more) break
      after = page.data.at(-1)?.id
      if (!after) throw new Error('Invalid refund pagination')
    } while (after)
    for (const refund of refunds) {
      if (idOf(refund.charge) !== charge.id || refund.currency !== 'usd')
        throw new Review('Refund does not match charge')
    }
    const successful = refunds.filter(r => r.status === 'succeeded').reduce((sum, r) => sum + r.amount, 0)
    if (successful > charge.amount) throw new Review('Refund total exceeds original payment')
    // A concurrent refund may have changed Stripe between reads. Retry the complete snapshot.
    if (successful !== charge.amount_refunded) throw new Error('Refund snapshot changed; retry')
    return { charge, refunds }
  }

  /** Called inside the credits/user/charge locks, including when a refunded Checkout arrives late. */
  async applyPackFacts(db: pg.PoolClient, userId: string, facts: ChargeFacts) {
    const { charge, refunds } = facts
    const cumulative = refunds.filter(r => r.status === 'succeeded').reduce((sum, r) => sum + r.amount, 0)
    await this.recordFacts(db, userId, facts)
    const grants = await db.query(`SELECT g.*,l.id AS lot_id,l.remaining,l.revoked,l.credits AS lot_credits
      FROM public.lb_credit_grants g LEFT JOIN public.lb_wallet_lots l ON l.grant_id=g.id
      WHERE g.user_id=$1 AND (g.stripe_charge_id=$2 OR g.stripe_payment_intent_id=$3)`, [userId, charge.id, idOf(charge.payment_intent) ?? null])
    if (!grants.rowCount) return false
    if (grants.rowCount !== 1) throw new Review('Ambiguous purchase association')
    const grant = grants.rows[0]
    if (!grant.lot_id || grant.source !== 'purchase' || grant.lot_credits !== grant.credits
      || grant.stripe_charge_id !== charge.id || Math.round(Number(grant.amount_usd) * 100) !== charge.amount
      || grant.stripe_account_id !== this.cfg.env.STRIPE_ACCOUNT_ID || grant.stripe_mode !== this.cfg.env.STRIPE_MODE)
      throw new Review('Historical purchase has no verified payment/remaining-credit association')
    const target = Math.min(grant.credits, Number(BigInt(grant.credits) * BigInt(cumulative) / BigInt(charge.amount)))
    // Monotonic target makes out-of-order snapshots harmless under the per-user lock.
    const processed = await db.query('SELECT coalesce(max(target_credits),0)::int AS target FROM public.lb_credit_reversals WHERE grant_id=$1', [grant.id])
    const delta = Math.max(0, target - processed.rows[0].target)
    if (!delta) return true
    const refund = refunds.filter(r => r.status === 'succeeded').toSorted((a, b) => b.created - a.created || b.id.localeCompare(a.id))[0]
    const unused = Math.min(delta, grant.remaining), debt = delta - unused
    const reversal = await db.query(`INSERT INTO public.lb_credit_reversals
      (user_id,refund_id,grant_id,granted_credits,target_credits,revoked_unused_credits,used_credits,debt_credits)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`, [userId, refund.id, grant.id, grant.credits, target, unused, debt])
    await db.query('UPDATE public.lb_wallet_lots SET remaining=remaining-$2,revoked=revoked+$2 WHERE id=$1', [grant.lot_id, unused])
    if (debt) {
      await db.query(`INSERT INTO public.lb_credit_debt_entries(entry_key,user_id,delta,reversal_id,reason)
        VALUES($1,$2,$3,$4,'refunded purchased credits already used')`, [`reversal:${reversal.rows[0].id}`, userId, debt, reversal.rows[0].id])
      await db.query('UPDATE public."user" SET credit_debt=credit_debt+$2 WHERE id=$1', [userId, debt])
    }
    await refreshWallet(db, userId)
    return true
  }

  private async recordFacts(db: pg.PoolClient, userId: string | null, facts: ChargeFacts) {
    for (const refund of facts.refunds) {
      await db.query(`INSERT INTO public.lb_billing_refunds(stripe_refund_id,stripe_charge_id,stripe_payment_intent_id,
        stripe_account_id,stripe_mode,user_id,amount_cents,original_amount_cents,cumulative_refunded_cents,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(stripe_refund_id) DO UPDATE SET
        status=CASE WHEN lb_billing_refunds.status='succeeded' THEN 'succeeded' ELSE excluded.status END,
        user_id=coalesce(lb_billing_refunds.user_id,excluded.user_id),
        cumulative_refunded_cents=greatest(lb_billing_refunds.cumulative_refunded_cents,excluded.cumulative_refunded_cents),updated_at=now()`,
      [refund.id, facts.charge.id, idOf(facts.charge.payment_intent) ?? null, this.cfg.env.STRIPE_ACCOUNT_ID,
        this.cfg.env.STRIPE_MODE, userId, refund.amount, facts.charge.amount, facts.charge.amount_refunded, refund.status ?? 'unknown'])
    }
  }

  private async invoiceFor(charge: Stripe.Charge) {
    const pi = idOf(charge.payment_intent)
    if (!pi) throw new Review('Charge has no PaymentIntent; manual association required')
    const payments = await this.stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: pi }, status: 'paid', limit: 100 })
    if (payments.has_more || payments.data.length !== 1 || payments.data[0].amount_paid !== charge.amount)
      throw new Review('Payment cannot be uniquely associated with a full subscription invoice')
    const invoice = await this.stripe.invoices.retrieve(idOf(payments.data[0].invoice)!)
    const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription)
    if (idOf(invoice.customer) !== idOf(charge.customer) || invoice.livemode !== charge.livemode || invoice.currency !== 'usd'
      || invoice.amount_paid !== charge.amount || !subscriptionId) throw new Review('Invoice association needs review')
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId)
    if (idOf(sub.customer) !== idOf(charge.customer) || sub.livemode !== charge.livemode || sub.items.data.length !== 1
      || ![this.cfg.stripePriceId('pro', false), this.cfg.stripePriceId('pro', true)].includes(sub.items.data[0].price.id))
      throw new Review('Invoice is not a supported Pro subscription')
    return { invoiceId: invoice.id, subscriptionId }
  }

  private async revokePro(db: pg.PoolClient, userId: string, chargeId: string, invoiceId: string, subId: string, reason: string) {
    await db.query(`INSERT INTO public.lb_subscription_revocations(subscription_id,user_id,invoice_id,charge_id,reason)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [subId, userId, invoiceId, chargeId, reason])
    // A refund for an old subscription must not revoke a replacement subscription or manual Business.
    await db.query(`UPDATE public."user" SET plan='free',stripe_paid_until=now(),stripe_status='canceled',
      stripe_entitlement_revoked_at=now(),stripe_cancel_at_period_end=false
      WHERE id=$1 AND stripe_subscription_id=$2 AND plan<>'business'`, [userId, subId])
    await this.action(db, `cancel:${subId}`, 'cancel_subscription', userId, { subscriptionId: subId })
    await this.action(db, `direct:${subId}`, 'revoke_direct', userId, {})
    await this.action(db, `queue:${subId}`, 'refresh_queue', userId, {})
  }

  private async processEvent(payload: { id: string; type: string; account: string; mode: string }, actionKey: string) {
    if (payload.account !== this.cfg.env.STRIPE_ACCOUNT_ID || payload.mode !== this.cfg.env.STRIPE_MODE)
      throw new Review('Action belongs to another Stripe account or mode')
    const account = await this.stripe.accounts.retrieve(null)
    if (account.id !== payload.account) throw new Review('Stripe account mismatch')
    let chargeId = payload.id
    let dispute: Stripe.Dispute | undefined
    if (payload.type.startsWith('refund.')) {
      const refund = await this.stripe.refunds.retrieve(payload.id)
      chargeId = idOf(refund.charge) ?? ''
    } else if (payload.type.startsWith('charge.dispute.')) {
      dispute = await this.stripe.disputes.retrieve(payload.id)
      if (dispute.livemode !== (payload.mode === 'live')) throw new Review('Dispute mode mismatch')
      chargeId = idOf(dispute.charge) ?? ''
    }
    if (!chargeId) throw new Review('No associated charge')
    const facts = await this.facts(chargeId)
    const user = await this.pool.query('SELECT * FROM public."user" WHERE stripe_customer_id=$1', [idOf(facts.charge.customer) ?? null])
    const row = user.rows[0]
    if (!row || row.stripe_account_id !== payload.account || row.stripe_mode !== payload.mode) {
      await this.transaction(db => this.recordFacts(db, null, facts))
      throw new Review('No verified local customer association')
    }
    await this.transaction(async db => {
      await this.recordFacts(db, row.id, facts)
      await db.query('UPDATE public.lb_billing_actions SET user_id=$2 WHERE action_key=$1', [actionKey, row.id])
    })
    // Resolve network state before opening a DB transaction; the durable outbox retries failures.
    const pack = await this.pool.query(`SELECT id FROM public.lb_credit_grants WHERE user_id=$1 AND
      (stripe_charge_id=$2 OR stripe_payment_intent_id=$3)`, [row.id, chargeId, idOf(facts.charge.payment_intent) ?? null])
    let invoice: { invoiceId: string; subscriptionId: string } | undefined, review: string | undefined
    if (!pack.rowCount) {
      try { invoice = await this.invoiceFor(facts.charge) }
      catch (error) {
        if (!(error instanceof Review)) throw error
        const pi = idOf(facts.charge.payment_intent)
        if (pi) {
          const checkouts = await this.stripe.checkout.sessions.list({ payment_intent: pi, limit: 2 })
          const checkout = !checkouts.has_more && checkouts.data.length === 1 ? checkouts.data[0] : undefined
          if (checkout?.mode === 'payment' && checkout.payment_status === 'paid' && checkout.metadata?.userId === row.id && packOf(checkout.metadata?.target ?? '')) {
            const historical = await this.pool.query('SELECT id FROM public.lb_credit_grants WHERE ref=$1', [checkout.id])
            // A refund can arrive before the paid Checkout. Let that webhook establish provenance,
            // then retry automatically; an existing unassociated historical grant still needs review.
            if (!historical.rowCount) throw new Error('Waiting for the paid Checkout receipt')
          }
        }
        review = error.message
      }
    }
    await this.transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`credits:${row.id}`])
      await db.query('SELECT id FROM public."user" WHERE id=$1 FOR UPDATE', [row.id])
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`refund:${chargeId}`])
      await this.recordFacts(db, row.id, facts)
      if (pack.rowCount) {
        try { await this.applyPackFacts(db, row.id, facts) }
        catch (error) { if (error instanceof Review) review = error.message; else throw error }
      } else if (invoice && (facts.charge.amount_refunded === facts.charge.amount || dispute?.status === 'lost')) {
        await this.revokePro(db, row.id, chargeId, invoice.invoiceId, invoice.subscriptionId, dispute?.status === 'lost' ? 'dispute_lost' : 'full_refund')
      }
    })
    if (review) throw new Review(review)
    if (dispute) throw new Review(`Dispute ${dispute.status}; ${dispute.status === 'lost' && invoice ? 'Pro revoked; ' : ''}review financial outcome separately; no refund amount invented`)
  }

  /** Lease/version prevents another worker's completion from overwriting a reclaimed action. */
  async retry(limit = 100) {
    await this.schema.ready()
    if (!this.cfg.billingEnabled) return
    if ((await this.pool.query('SELECT paused FROM public.lb_billing_control WHERE id=1')).rows[0]?.paused) return
    for (let i = 0; i < limit; i++) {
      const r = await this.pool.query(`UPDATE public.lb_billing_actions SET status='running',lease_until=now()+interval '5 minutes',
        version=version+1,attempts=attempts+1,updated_at=now() WHERE action_key=(
          SELECT action_key FROM public.lb_billing_actions WHERE
          (status='pending' AND available_at<=now()) OR (status='running' AND lease_until<now())
          ORDER BY created_at,action_key FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)
      const action = r.rows[0]
      if (!action) break
      try {
        if (action.kind === 'refund_event') await this.processEvent(action.payload, action.action_key)
        else if (action.kind === 'cancel_subscription') {
          const sub = await this.stripe.subscriptions.retrieve(action.payload.subscriptionId)
          const binding = (await this.pool.query('SELECT stripe_customer_id,stripe_account_id,stripe_mode FROM public."user" WHERE id=$1', [action.user_id])).rows[0]
          const account = await this.stripe.accounts.retrieve(null)
          if (account.id !== this.cfg.env.STRIPE_ACCOUNT_ID || binding?.stripe_account_id !== account.id || binding?.stripe_mode !== this.cfg.env.STRIPE_MODE
            || idOf(sub.customer) !== binding?.stripe_customer_id
            || sub.livemode !== (this.cfg.env.STRIPE_MODE === 'live')) throw new Review('Subscription cancellation association mismatch')
          if (!['canceled', 'incomplete_expired'].includes(sub.status)) await this.stripe.subscriptions.cancel(sub.id, { prorate: false, invoice_now: false })
        } else if (action.kind === 'revoke_direct') await this.direct.reconcile(action.user_id)
        else if (action.kind === 'refresh_queue') await this.queues.refreshPriorities()
        else throw new Review('Unknown billing action')
        await this.pool.query(`UPDATE public.lb_billing_actions SET status='complete',lease_until=null,review_reason=null,updated_at=now()
          WHERE action_key=$1 AND version=$2`, [action.action_key, action.version])
      } catch (error) {
        const review = error instanceof Review || action.attempts >= 20
        await this.pool.query(`UPDATE public.lb_billing_actions SET status=$3,lease_until=null,review_reason=$4,
          available_at=now()+($5::int*interval '1 second'),updated_at=now() WHERE action_key=$1 AND version=$2`,
        [action.action_key, action.version, review ? 'manual_review' : 'pending',
          error instanceof Review ? error.message : 'External service or database unavailable; retry required', Math.min(3600, 2 ** Math.min(action.attempts, 12))])
      }
    }
  }

  async overview() {
    await this.schema.ready()
    const [refunds, actions, debts, historical, ledger, audit] = await Promise.all([
      this.pool.query(`SELECT f.*,u.email,g.credits AS purchased_credits,
        (SELECT coalesce(sum(revoked_unused_credits),0)::int FROM public.lb_credit_reversals WHERE grant_id=g.id) AS revoked,
        (SELECT coalesce(sum(debt_credits),0)::int FROM public.lb_credit_reversals WHERE grant_id=g.id) AS debt_created,
        l.consumed,l.debt_settled,s.subscription_id AS revoked_subscription
        FROM public.lb_billing_refunds f LEFT JOIN public."user" u ON u.id=f.user_id
        LEFT JOIN public.lb_credit_grants g ON g.stripe_charge_id=f.stripe_charge_id
        LEFT JOIN public.lb_wallet_lots l ON l.grant_id=g.id
        LEFT JOIN public.lb_subscription_revocations s ON s.charge_id=f.stripe_charge_id
        ORDER BY f.updated_at DESC LIMIT 100`),
      this.pool.query(`SELECT action_key,kind,user_id,status,attempts,review_reason,created_at,updated_at
        FROM public.lb_billing_actions ORDER BY CASE status WHEN 'manual_review' THEN 0 WHEN 'pending' THEN 1 WHEN 'running' THEN 2 ELSE 3 END,updated_at DESC LIMIT 100`),
      this.pool.query(`SELECT id,email,credit_debt,paid_credit_locked FROM public."user" WHERE credit_debt>0 ORDER BY email`),
      this.pool.query(`SELECT g.id::text,g.user_id,u.email,g.ref,g.credits,g.amount_usd,g.created_at
        FROM public.lb_credit_grants g JOIN public."user" u ON u.id=g.user_id
        LEFT JOIN public.lb_wallet_lots l ON l.grant_id=g.id
        WHERE g.source='purchase' AND (g.stripe_charge_id IS NULL OR l.id IS NULL) ORDER BY g.created_at LIMIT 100`),
      this.pool.query(`SELECT d.entry_key,d.user_id,u.email,d.delta,d.actor,d.reason,d.created_at
        FROM public.lb_credit_debt_entries d LEFT JOIN public."user" u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 100`),
      this.pool.query(`SELECT action_key,actor,operation,reason,created_at FROM public.lb_billing_admin_audit ORDER BY created_at DESC LIMIT 100`),
    ])
    // RPC-safe values; do not expose event payloads or credentials.
    return JSON.parse(JSON.stringify({ refunds: refunds.rows, actions: actions.rows, debts: debts.rows, historical: historical.rows, ledger: ledger.rows, audit: audit.rows })) as {
      refunds: Array<{ stripe_refund_id: string; stripe_charge_id: string; email: string | null; amount_cents: number; original_amount_cents: number; cumulative_refunded_cents: number; status: string; purchased_credits: number | null; revoked: number; debt_created: number; consumed: number | null; debt_settled: number | null; revoked_subscription: string | null; created_at: string }>
      actions: Array<{ action_key: string; kind: string; user_id: string | null; status: string; attempts: number; review_reason: string | null; updated_at: string }>
      debts: Array<{ id: string; email: string; credit_debt: number; paid_credit_locked: boolean }>
      historical: Array<{ id: string; user_id: string; email: string; ref: string | null; credits: number; amount_usd: string; created_at: string }>
      ledger: Array<{ entry_key: string; user_id: string; email: string | null; delta: number; actor: string | null; reason: string; created_at: string }>
      audit: Array<{ action_key: string; actor: string; operation: string; reason: string; created_at: string }>
    }
  }

  async retryReviewed(actionKey: string, actor: string, reason: string) {
    await this.schema.ready()
    if (!reason.trim()) throw new DomainError('Review reason required')
    await this.transaction(async db => {
      const r = await db.query(`UPDATE public.lb_billing_actions SET status='pending',attempts=0,available_at=now(),version=version+1,
        review_reason=null,updated_at=now() WHERE action_key=$1 AND status IN ('manual_review','pending') RETURNING action_key`, [actionKey])
      if (!r.rowCount) throw new DomainError('Action is complete or currently running')
      await db.query(`INSERT INTO public.lb_billing_admin_audit(action_key,actor,operation,reason) VALUES($1,$2,'retry',$3)`, [actionKey, actor, reason.slice(0, 500)])
    })
  }

  async forgiveDebt(userId: string, amount: number, key: string, actor: string, reason: string) {
    await this.schema.ready()
    if (!Number.isSafeInteger(amount) || amount <= 0 || !reason.trim()) throw new DomainError('Positive credits and review reason required')
    await this.transaction(async db => {
      if ((await db.query('SELECT paused FROM public.lb_billing_control WHERE id=1')).rows[0]?.paused) throw new DomainError('Billing maintenance: wallet changes are paused')
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`credits:${userId}`])
      const u = await db.query('SELECT credit_debt FROM public."user" WHERE id=$1 FOR UPDATE', [userId])
      if ((await db.query('SELECT entry_key FROM public.lb_credit_debt_entries WHERE entry_key=$1', [`admin:${key}`])).rowCount) return
      if (!u.rows[0] || amount > u.rows[0].credit_debt) throw new DomainError('Adjustment exceeds outstanding debt')
      await db.query(`INSERT INTO public.lb_credit_debt_entries(entry_key,user_id,delta,actor,reason) VALUES($1,$2,$3,$4,$5)`, [`admin:${key}`, userId, -amount, actor, reason.slice(0, 500)])
      await db.query('UPDATE public."user" SET credit_debt=credit_debt-$2,paid_credit_locked=(credit_debt-$2)>0 WHERE id=$1', [userId, amount])
    })
  }
}
