import 'reflect-metadata'
import { config } from 'dotenv'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { Stripe } from 'stripe'
import { ConfigService } from '../src/config/config.service'
import { SchemaService } from '../src/database/schema.service'
import { BillingService } from '../src/modules/billing/billing.service'
import { RefundsService } from '../src/modules/billing/refunds.service'
import { CreditsService } from '../src/modules/credits/credits.service'
import { addWalletGrant, walletReady } from '../src/modules/credits/wallet'
import { STRIPE_API_VERSION } from '../src/modules/billing/stripe-contract'

// Explicit opt-in remote regression. No production database or Live key is accepted.
config({ path: new URL('../../app/.env', import.meta.url).pathname, quiet: true })
if (process.env.STRIPE_MODE !== 'test' || !/^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY ?? '')) throw new Error('Stripe Test mode/key required')
if (!process.env.REFUND_TEST_DATABASE_URL) throw new Error('REFUND_TEST_DATABASE_URL must point to a disposable local PostgreSQL')
const base = new URL(process.env.REFUND_TEST_DATABASE_URL)
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('Only local regression databases are allowed')
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2 })
const admin = new Pool({ connectionString: base.href })
const name = 'refund_e2e_' + randomUUID().replaceAll('-', '')
let pool: Pool | undefined, customerId: string | undefined
const subscriptionIds: string[] = []
const oid = (v: string | { id: string } | null | undefined) => typeof v === 'string' ? v : v?.id
try {
  const account = await stripe.accounts.retrieve(null)
  assert.equal(account.id, process.env.STRIPE_ACCOUNT_ID, 'Test account mismatch')
  await admin.query(`CREATE DATABASE "${name}"`)
  base.pathname = '/' + name
  pool = new Pool({ connectionString: base.href })
  const cfg = ConfigService.of(process.env), schema = new SchemaService(pool)
  await schema.ready()
  const direct = { reconcile: async () => {} }, queues = { refreshPriorities: async () => {} }
  const refunds = new RefundsService(pool, cfg, schema, direct as any, queues as any)
  const billing = new BillingService(pool, cfg, schema, direct as any, queues as any, refunds)
  const credits = new CreditsService(pool, schema), userId = randomUUID()
  const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } })
  const customer = await stripe.customers.create({ payment_method: pm.id, invoice_settings: { default_payment_method: pm.id }, metadata: { lovbase_refund_regression: userId } })
  customerId = customer.id
  await pool.query(`INSERT INTO public."user"(id,name,email,"createdAt","updatedAt",stripe_customer_id,stripe_account_id,stripe_mode)
    VALUES($1,'Refund regression',$2,now(),now(),$3,$4,'test')`, [userId, `${userId}@test.invalid`, customer.id, account.id])
  async function deliver(type: string, id: string) {
    const evt = { id: `evt_local_${randomUUID()}`, livemode: false, type, data: { object: { id, customer: customer.id } } } as Stripe.Event
    await billing.apply(evt); await refunds.retry()
    const pending = await pool!.query("SELECT action_key,status,review_reason FROM public.lb_billing_actions WHERE status<>'complete'")
    assert.equal(pending.rowCount, 0, `Actions incomplete: ${JSON.stringify(pending.rows)}`)
  }
  const purchase = async () => {
    const pi = await stripe.paymentIntents.create({ amount: 1000, currency: 'usd', customer: customer.id, payment_method: pm.id,
      confirm: true, off_session: true, automatic_payment_methods: { enabled: true, allow_redirects: 'never' }, metadata: { lovbase_refund_regression: userId } })
    assert.equal(pi.status, 'succeeded')
    const chargeId = oid(pi.latest_charge)!
    const db = await pool!.connect()
    try {
      await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`credits:${userId}`])
      await walletReady(db, userId)
      const grant = await db.query(`INSERT INTO public.lb_credit_grants(user_id,credits,source,amount_usd,ref,stripe_payment_intent_id,stripe_charge_id,stripe_account_id,stripe_mode)
        VALUES($1,200,'purchase',10,$2,$2,$3,$4,'test') RETURNING id`, [userId, pi.id, chargeId, account.id])
      await addWalletGrant(db, userId, grant.rows[0].id, 200, 'purchase')
      await db.query('COMMIT')
    } catch (error) { await db.query('ROLLBACK'); throw error }
    finally { db.release() }
    return chargeId
  }
  const chargeId = await purchase()
  await credits.grant(userId, 50, { source: 'admin', note: 'Test regression gift' })
  assert.equal(await credits.charge(userId, { kind: 'message', credits: 105, idempotencyKey: 'regression-spend' }), true)
  const partial = await stripe.refunds.create({ charge: chargeId, amount: 500 })
  await deliver('refund.created', partial.id)
  assert.equal((await credits.balanceOf(userId)).bonus, 75)
  const rest = await stripe.refunds.create({ charge: chargeId })
  await deliver('refund.created', rest.id)
  await deliver('refund.updated', partial.id)
  assert.equal((await credits.balanceOf(userId)).debt, 75)
  assert.equal((await credits.balanceOf(userId)).bonus, 50)
  const replacementCharge = await purchase()
  assert.equal((await credits.balanceOf(userId)).debt, 0)
  assert.equal((await credits.balanceOf(userId)).bonus, 175)
  await stripe.refunds.create({ charge: replacementCharge })
  await deliver('charge.refunded', replacementCharge)
  for (const yearly of [false, true]) {
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: cfg.stripePriceId('pro', yearly) }], payment_behavior: 'error_if_incomplete', default_payment_method: pm.id, metadata: { lovbase_refund_regression: userId } })
    subscriptionIds.push(sub.id)
    const invoiceId = oid(sub.latest_invoice)!
    await deliver('invoice.paid', invoiceId)
    assert.equal((await credits.balanceOf(userId)).plan, 'pro')
    const payments = await stripe.invoicePayments.list({ invoice: invoiceId, status: 'paid', limit: 100 })
    const pi = await stripe.paymentIntents.retrieve(oid(payments.data[0].payment.payment_intent)!)
    const refund = await stripe.refunds.create({ charge: oid(pi.latest_charge)! })
    await deliver('refund.created', refund.id)
    assert.equal((await credits.balanceOf(userId)).plan, 'free')
    assert.equal((await stripe.subscriptions.retrieve(sub.id)).status, 'canceled')
    await deliver('customer.subscription.updated', sub.id)
    assert.equal((await credits.balanceOf(userId)).plan, 'free')
  }
  console.log('Stripe Test refund regression passed: partial/cumulative pack refunds, duplicate events, protected gifts, debt settlement, monthly/annual Pro cancellation and stale-event fence.')
} catch (error) {
  console.error(error instanceof Stripe.errors.StripeError ? `Stripe Test regression failed (${error.type}, ${error.code ?? 'unknown'}); inspect Test Dashboard` : error instanceof Error ? error.message : 'Regression failed')
  process.exitCode = 1
} finally {
  for (const id of subscriptionIds) await stripe.subscriptions.cancel(id, { prorate: false, invoice_now: false }).catch(() => {})
  if (customerId) await stripe.customers.del(customerId).catch(() => {})
  if (pool) { await pool.end(); await admin.query(`DROP DATABASE "${name}"`).catch(() => {}) }
  await admin.end()
}
