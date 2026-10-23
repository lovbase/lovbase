import 'reflect-metadata'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { Stripe } from 'stripe'
import { ConfigService } from '../src/config/config.service'
import { SchemaService } from '../src/database/schema.service'
import { BillingService } from '../src/modules/billing/billing.service'
import { RefundsService } from '../src/modules/billing/refunds.service'
import { CreditsService } from '../src/modules/credits/credits.service'
import { DirectDatabaseService } from '../src/modules/entitlements/direct-database.service'
import { LimitsService } from '../src/modules/limits/limits.service'

// CI runs this entire suite with PostgreSQL 17. Local fallback exercises identical SQL on PGlite.
const url = process.env.BILLING_TEST_DATABASE_URL
const database = `refund_test_${randomUUID().replaceAll('-', '')}`
const admin = url ? new pg.Pool({ connectionString: url }) : undefined
const memory = url ? undefined : new PGlite()
let tail = Promise.resolve()
async function acquire() { const prior = tail; let release!: () => void; tail = new Promise(r => { release = r }); await prior; return release }
async function memoryQuery(sql: string, values?: unknown[]) { const r = await memory!.query(sql, values); return { rows: r.rows, rowCount: r.affectedRows || r.rows.length } }
let pool: pg.Pool, schema: SchemaService, billing: BillingService, refunds: RefundsService, credits: CreditsService
const cfg = ConfigService.of({
  STRIPE_MODE: 'test', STRIPE_ACCOUNT_ID: 'acct_refunds', STRIPE_PORTAL_CONFIGURATION: 'bpc_refunds',
  STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', BETTER_AUTH_URL: 'http://localhost:3008',
  STRIPE_PRICE_PRO_MONTHLY: 'price_month', STRIPE_PRICE_PRO_YEARLY: 'price_year',
  STRIPE_PRICE_CREDITS_SMALL: 'price_small', STRIPE_PRICE_CREDITS_MEDIUM: 'price_medium', STRIPE_PRICE_CREDITS_LARGE: 'price_large',
})
const charges = new Map<string, any>(), refundMap = new Map<string, any>(), sessions = new Map<string, any>()
const subscriptions = new Map<string, any>(), invoices = new Map<string, any>(), disputes = new Map<string, any>()
const cancelFailures = new Set<string>(), directFailures = new Set<string>()
const canceled: string[] = [], directSynced: string[] = []
let refundApiFails = 0, queueFails = 0
const fake = {
  accounts: { retrieve: async () => ({ id: 'acct_refunds', charges_enabled: true }) },
  charges: { retrieve: async (id: string) => structuredClone(charges.get(id)) },
  paymentIntents: { retrieve: async (id: string) => { const c = [...charges.values()].find(c => c.payment_intent === id); return { id, customer: c.customer, latest_charge: c.id } } },
  refunds: {
    retrieve: async (id: string) => { if (refundApiFails-- > 0) throw new Error('network'); return structuredClone(refundMap.get(id)) },
    list: async ({ charge, starting_after }: any) => {
      const all = [...refundMap.values()].filter(r => r.charge === charge)
      const start = starting_after ? all.findIndex(r => r.id === starting_after) + 1 : 0
      // Deliberately paginate at two, ensuring callers cannot use the embedded charge preview.
      return { data: structuredClone(all.slice(start, start + 2)), has_more: all.length > start + 2 }
    },
  },
  disputes: { retrieve: async (id: string) => structuredClone(disputes.get(id)) },
  subscriptions: {
    list: async ({ customer }: any) => ({ data: structuredClone([...subscriptions.values()].filter(s => s.customer === customer)), has_more: false }),
    retrieve: async (id: string) => structuredClone(subscriptions.get(id)),
    cancel: async (id: string) => { if (cancelFailures.has(id)) throw new Error('Stripe unavailable'); subscriptions.get(id).status = 'canceled'; canceled.push(id); return subscriptions.get(id) },
  },
  invoicePayments: { list: async ({ payment }: any) => ({ data: [...invoices.values()].filter(i => i.pi === payment.payment_intent).map(i => ({ invoice: i.id, amount_paid: i.amount_paid })), has_more: false }) },
  invoices: {
    retrieve: async (id: string) => structuredClone(invoices.get(id)),
    list: async ({ subscription }: any) => ({ data: structuredClone([...invoices.values()].filter(i => i.parent.subscription_details.subscription === subscription).slice(-1)), has_more: false }),
    listLineItems: async (id: string) => ({ data: structuredClone(invoices.get(id).lines), has_more: false }),
  },
  checkout: { sessions: {
    list: async ({ payment_intent }: any) => ({ data: structuredClone([...sessions.values()].filter(s => s.payment_intent === payment_intent)), has_more: false }),
    retrieve: async (id: string) => structuredClone(sessions.get(id)),
    listLineItems: async (id: string) => ({ data: [{ price: { id: sessions.get(id).price }, quantity: 1 }], has_more: false }),
  } },
}
beforeAll(async () => {
  if (admin) {
    await admin.query(`CREATE DATABASE "${database}"`)
    const connection = new URL(url!); connection.pathname = '/' + database
    pool = new pg.Pool({ connectionString: connection.href, max: 12 })
  } else {
    pool = {
      query: memoryQuery,
      connect: async () => ({ query: memoryQuery, release: await acquire() }),
    } as unknown as pg.Pool
  }
  schema = new SchemaService(pool)
  await schema.ready()
  const direct = { reconcile: async (id: string) => { if (directFailures.has(id)) throw new Error('direct db unavailable'); directSynced.push(id) } }
  const queues = { refreshPriorities: async () => { if (queueFails-- > 0) throw new Error('redis unavailable') } }
  refunds = new RefundsService(pool, cfg, schema, direct as any, queues as any)
  billing = new BillingService(pool, cfg, schema, direct as any, queues as any, refunds)
  credits = new CreditsService(pool, schema)
  Object.assign(refunds, { client: fake }); Object.assign(billing, { client: fake })
}, 30_000)
afterAll(async () => {
  if (admin) { await pool.end(); await admin.query(`DROP DATABASE "${database}"`); await admin.end() }
  else await memory!.close()
})

const event = (type: string, id: string, eventId = `evt_${randomUUID()}`) => ({ id: eventId, livemode: false, type, data: { object: { id } } }) as Stripe.Event
async function user() {
  const id = randomUUID()
  await pool.query(`INSERT INTO public."user"(id,name,email,"createdAt","updatedAt",stripe_customer_id,stripe_account_id,stripe_mode)
    VALUES($1,$1,$2,now(),now(),$3,'acct_refunds','test')`, [id, `${id}@test.invalid`, `cus_${id}`])
  return id
}
function charge(userId: string, amount = 1000) {
  const id = `ch_${randomUUID()}`
  const c = { id, customer: `cus_${userId}`, amount, amount_refunded: 0, paid: true, currency: 'usd', livemode: false, payment_intent: `pi_${id}` }
  charges.set(id, c); return c
}
async function pack(userId: string, beforePaid?: (c: any) => void | Promise<void>) {
  const c = charge(userId)
  const s = { id: `cs_${randomUUID()}`, customer: c.customer, payment_intent: c.payment_intent, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 1000, currency: 'usd', price: 'price_small', metadata: { userId, target: 'small', yearly: 'false' } }
  sessions.set(s.id, s)
  await beforePaid?.(c)
  await billing.apply({ ...event('checkout.session.completed', s.id), data: { object: s } } as any)
  return c
}
function refund(c: any, amount: number, status = 'succeeded') {
  const r = { id: `re_${randomUUID()}`, charge: c.id, payment_intent: c.payment_intent, currency: 'usd', amount, status, created: Math.floor(Date.now() / 1000) }
  refundMap.set(r.id, r)
  c.amount_refunded = [...refundMap.values()].filter(r => r.charge === c.id && r.status === 'succeeded').reduce((a, r) => a + r.amount, 0)
  return r
}
async function deliver(r: { id: string }, type = 'refund.created') { await billing.apply(event(type, r.id)); await refunds.retry() }
async function sub(userId: string, yearly = false) {
  const c = charge(userId, yearly ? 24000 : 2500), id = `sub_${randomUUID()}`, invoiceId = `in_${randomUUID()}`
  const start = Math.floor(Date.now() / 1000) - 60, end = start + (yearly ? 365 : 30) * 86400
  const price = yearly ? 'price_year' : 'price_month'
  subscriptions.set(id, { id, customer: c.customer, livemode: false, created: start, status: 'active', cancel_at_period_end: false, items: { data: [{ price: { id: price, recurring: { interval: yearly ? 'year' : 'month' } } }] } })
  invoices.set(invoiceId, { id: invoiceId, customer: c.customer, amount_paid: c.amount, currency: 'usd', status: 'paid', livemode: false, pi: c.payment_intent,
    parent: { subscription_details: { subscription: id } }, lines: [{ pricing: { price_details: { price } }, parent: { type: 'subscription_item_details', subscription_item_details: { proration: false } }, period: { start, end } }] })
  await billing.apply({ ...event('invoice.paid', invoiceId), data: { object: { id: invoiceId, customer: c.customer } } } as any)
  return { id, c }
}
async function due() { await pool.query("UPDATE public.lb_billing_actions SET available_at=now() WHERE status='pending'"); await refunds.retry() }
async function spend(userId: string, walletAmount: number) {
  expect(await credits.charge(userId, { kind: 'message', credits: 30 + walletAmount, idempotencyKey: randomUUID() })).toBe(true)
}

test('full pack refund revokes all unspent credits without rewriting the grant', async () => {
  const u = await user(), c = await pack(u)
  await deliver(refund(c, 1000))
  expect(await credits.balanceOf(u)).toMatchObject({ bonus: 0, debt: 0, lockedPurchased: 0 })
  expect((await pool.query('SELECT credits FROM public.lb_credit_grants WHERE user_id=$1', [u])).rows[0].credits).toBe(200)
  expect((await pool.query('SELECT revoked_unused_credits FROM public.lb_credit_reversals WHERE user_id=$1', [u])).rows[0].revoked_unused_credits).toBe(200)
})

test('used purchase becomes debt; gifts are protected, and later purchases settle debt first', async () => {
  const u = await user(), c = await pack(u)
  await credits.grant(u, 50, { source: 'admin', ref: randomUUID() })
  await spend(u, 75)
  await deliver(refund(c, 1000))
  expect(await credits.balanceOf(u)).toMatchObject({ bonus: 50, debt: 75, left: 50 })
  await credits.grant(u, 25, { source: 'admin' })
  expect((await credits.balanceOf(u)).debt).toBe(75)
  const second = await pack(u)
  expect(await credits.balanceOf(u)).toMatchObject({ bonus: 200, debt: 0 }) // 75 gifts + 125 purchased
  await deliver(refund(second, 1000))
  expect(await credits.balanceOf(u)).toMatchObject({ bonus: 75, debt: 75 }) // refund also reverses debt settlement
})

test('cumulative partial refunds use floor and do not double count repeated/older deliveries', async () => {
  const u = await user(), c = await pack(u)
  const first = refund(c, 333); await deliver(first)
  expect((await credits.balanceOf(u)).bonus).toBe(134)
  const second = refund(c, 167); await deliver(second)
  expect((await credits.balanceOf(u)).bonus).toBe(100)
  const same = event('refund.updated', first.id)
  await Promise.all([billing.apply(same), billing.apply(same), billing.apply(event('charge.refunded', c.id))])
  await Promise.all([refunds.retry(), refunds.retry()])
  expect((await credits.balanceOf(u)).bonus).toBe(100)
  await deliver(refund(c, 500))
  expect(await credits.balanceOf(u)).toMatchObject({ bonus: 0, debt: 0 })
  expect((await pool.query('SELECT sum(revoked_unused_credits)::int AS n FROM public.lb_credit_reversals WHERE user_id=$1', [u])).rows[0].n).toBe(200)
})

test('refunds pending or failed never revoke; pagination accounts for every successful refund', async () => {
  const u = await user(), c = await pack(u)
  await deliver(refund(c, 100, 'pending'))
  await deliver(refund(c, 100, 'failed'))
  expect((await credits.balanceOf(u)).bonus).toBe(200)
  refund(c, 100); refund(c, 200); await deliver(refund(c, 200))
  expect((await credits.balanceOf(u)).bonus).toBe(100)
})

test('late paid Checkout reconciles an already refunded payment before exposing credits', async () => {
  const u = await user()
  await pack(u, c => refund(c, 1000))
  expect(await credits.balanceOf(u)).toMatchObject({ bonus: 0, debt: 0 })
})

test('a refund delivered before the paid webhook automatically recovers after the receipt arrives', async () => {
  const u = await user()
  let eventId = ''
  await pack(u, async c => {
    const r = refund(c, 1000), evt = event('refund.created', r.id)
    eventId = evt.id
    await billing.apply(evt); await refunds.retry()
    expect((await pool.query('SELECT status FROM public.lb_billing_actions WHERE action_key=$1', [`event:${evt.id}`])).rows[0].status).toBe('pending')
  })
  expect((await credits.balanceOf(u)).bonus).toBe(0)
  await due()
  expect((await pool.query('SELECT status FROM public.lb_billing_actions WHERE action_key=$1', [`event:${eventId}`])).rows[0].status).toBe('complete')
})

test('purchased credits freeze while debt exists; gifts can still fund work', async () => {
  const u = await user(), first = await pack(u)
  await pack(u); await spend(u, 200)
  await deliver(refund(first, 1000))
  expect(await credits.balanceOf(u)).toMatchObject({ bonus: 200, debt: 200, lockedPurchased: 200, left: 0 })
  await expect(credits.assert(u, 'message')).rejects.toThrow('Credits used up')
  await credits.grant(u, 20)
  await credits.charge(u, { kind: 'message', credits: 10, idempotencyKey: randomUUID() })
  expect(await credits.balanceOf(u)).toMatchObject({ bonus: 210, debt: 200, lockedPurchased: 200, left: 10 })
  await pack(u)
  expect(await credits.balanceOf(u)).toMatchObject({ bonus: 210, debt: 0, lockedPurchased: 0 })
})

test('Refund API failures persist retryable work and duplicate webhook cannot duplicate debt', async () => {
  const u = await user(), c = await pack(u); await spend(u, 75)
  const r = refund(c, 1000), evt = event('refund.created', r.id)
  refundApiFails = 1
  expect(await billing.apply(evt)).toBe(true)
  await refunds.retry()
  expect((await credits.balanceOf(u)).bonus).toBe(125)
  expect((await pool.query('SELECT status,attempts FROM public.lb_billing_actions WHERE action_key=$1', [`event:${evt.id}`])).rows[0]).toMatchObject({ status: 'pending', attempts: 1 })
  expect(await billing.apply(evt)).toBe(false)
  await due()
  expect(await credits.balanceOf(u)).toMatchObject({ bonus: 0, debt: 75 })
  await deliver(r, 'refund.updated')
  expect((await credits.balanceOf(u)).debt).toBe(75)
})

test('a failed reversal transaction keeps wallet intact, persists refund facts and retries atomically', async () => {
  const u = await user(), c = await pack(u), r = refund(c, 1000)
  const suffix = randomUUID().replaceAll('-', '')
  await pool.query(`CREATE FUNCTION public.refund_fail_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.user_id='${u}' THEN RAISE EXCEPTION 'simulated reversal storage failure'; END IF; RETURN NEW; END $$`)
  await pool.query(`CREATE TRIGGER refund_fail_${suffix} BEFORE INSERT ON public.lb_credit_reversals FOR EACH ROW EXECUTE FUNCTION public.refund_fail_${suffix}()`)
  try {
    await deliver(r)
    expect((await credits.balanceOf(u)).bonus).toBe(200)
    expect((await pool.query('SELECT * FROM public.lb_billing_refunds WHERE stripe_refund_id=$1', [r.id])).rowCount).toBe(1)
    expect((await pool.query('SELECT * FROM public.lb_credit_reversals WHERE user_id=$1', [u])).rowCount).toBe(0)
  } finally {
    await pool.query(`DROP TRIGGER refund_fail_${suffix} ON public.lb_credit_reversals`)
    await pool.query(`DROP FUNCTION public.refund_fail_${suffix}()`)
  }
  await due()
  expect((await credits.balanceOf(u)).bonus).toBe(0)
})

test('exhausted external retries stop for explicit manual review', async () => {
  const u = await user(), c = await pack(u), r = refund(c, 1000), evt = event('refund.created', r.id)
  await billing.apply(evt)
  await pool.query('UPDATE public.lb_billing_actions SET attempts=19 WHERE action_key=$1', [`event:${evt.id}`])
  refundApiFails = 1; await refunds.retry()
  expect((await pool.query('SELECT status,attempts FROM public.lb_billing_actions WHERE action_key=$1', [`event:${evt.id}`])).rows[0]).toMatchObject({ status: 'manual_review', attempts: 20 })
  await expect(refunds.retryReviewed(`event:${evt.id}`, 'admin', '')).rejects.toThrow('reason')
  await refunds.retryReviewed(`event:${evt.id}`, 'admin', 'Stripe API restored')
  await refunds.retry()
  expect((await credits.balanceOf(u)).bonus).toBe(0)
})

test('maintenance pause accepts the refund inbox but holds wallet mutations until resumed', async () => {
  const u = await user(), c = await pack(u), r = refund(c, 1000)
  await pool.query('UPDATE public.lb_billing_control SET paused=true WHERE id=1')
  try {
    await deliver(r)
    expect((await credits.balanceOf(u)).bonus).toBe(200)
  } finally { await pool.query('UPDATE public.lb_billing_control SET paused=false WHERE id=1') }
  await refunds.retry()
  expect((await credits.balanceOf(u)).bonus).toBe(0)
})

test('full Pro invoice refund revokes locally even if remote cancellation and permission sync fail', async () => {
  const u = await user(), s = await sub(u)
  expect((await credits.balanceOf(u)).plan).toBe('pro')
  cancelFailures.add(s.id); directFailures.add(u); queueFails = 1
  await deliver(refund(s.c, 2500))
  expect((await credits.balanceOf(u)).plan).toBe('free')
  expect(subscriptions.get(s.id).status).toBe('active')
  // Late invoice/subscription events cannot restore the refunded subscription.
  await billing.apply({ ...event('customer.subscription.updated', s.id), data: { object: { id: s.id, customer: s.c.customer } } } as any)
  expect((await credits.balanceOf(u)).plan).toBe('free')
  cancelFailures.delete(s.id); directFailures.delete(u)
  await due()
  expect(subscriptions.get(s.id).status).toBe('canceled')
  expect(canceled.filter(id => id === s.id)).toHaveLength(1)
  expect(directSynced).toContain(u)
  expect((await pool.query("SELECT * FROM public.lb_billing_actions WHERE user_id=$1 AND status<>'complete'", [u])).rows).toHaveLength(0)
})

test('partial annual Pro refund retains rights until cumulative full invoice refund', async () => {
  const u = await user(), s = await sub(u, true)
  await deliver(refund(s.c, 12000))
  expect((await credits.balanceOf(u)).plan).toBe('pro')
  expect(canceled).not.toContain(s.id)
  await deliver(refund(s.c, 12000))
  expect((await credits.balanceOf(u)).plan).toBe('free')
  expect(canceled).toContain(s.id)
})

test('old subscription refund leaves replacement subscription and manual Business intact', async () => {
  const u = await user(), old = await sub(u), replacement = await sub(u)
  await pool.query('UPDATE public."user" SET stripe_subscription_id=$2 WHERE id=$1', [u, replacement.id])
  await deliver(refund(old.c, 2500))
  expect((await credits.balanceOf(u)).plan).toBe('pro')
  expect(canceled).not.toContain(replacement.id)
  await credits.setPlan(u, 'business')
  await deliver(refund(replacement.c, 2500))
  expect((await pool.query('SELECT plan FROM public."user" WHERE id=$1', [u])).rows[0].plan).toBe('business')
  expect((await credits.balanceOf(u)).plan).toBe('business')
})

test('open/won disputes are review-only; lost Pro dispute revokes without inventing a refund', async () => {
  const u = await user(), s = await sub(u)
  const dispute = { id: `dp_${randomUUID()}`, charge: s.c.id, livemode: false, status: 'needs_response' }
  disputes.set(dispute.id, dispute)
  await deliver(dispute, 'charge.dispute.created')
  expect((await credits.balanceOf(u)).plan).toBe('pro')
  dispute.status = 'won'; await deliver(dispute, 'charge.dispute.closed')
  expect((await credits.balanceOf(u)).plan).toBe('pro')
  dispute.status = 'lost'; await deliver(dispute, 'charge.dispute.closed')
  expect((await credits.balanceOf(u)).plan).toBe('free')
  expect((await pool.query('SELECT * FROM public.lb_billing_refunds WHERE stripe_charge_id=$1', [s.c.id])).rows).toHaveLength(0)
})

test('historical unassociated purchase is reviewed and never deducts protected opening balance', async () => {
  const u = await user(), c = charge(u), r = refund(c, 1000)
  await pool.query('UPDATE public."user" SET credits_bonus=150 WHERE id=$1', [u])
  await pool.query("INSERT INTO public.lb_credit_grants(user_id,credits,source,amount_usd,ref) VALUES($1,200,'purchase',10,'legacy_'||$1)", [u])
  await deliver(r)
  expect(await credits.balanceOf(u)).toMatchObject({ bonus: 150, debt: 0 })
  const overview = await refunds.overview()
  expect(overview.historical.some(g => g.user_id === u)).toBe(true)
  expect(overview.actions.some(a => a.status === 'manual_review')).toBe(true)
})

test('admin debt forgiveness is separate, idempotent, and cannot exceed actual debt', async () => {
  const u = await user(), c = await pack(u); await spend(u, 75); await deliver(refund(c, 1000))
  const key = randomUUID()
  await refunds.forgiveDebt(u, 25, key, 'admin@test.invalid', 'verified settlement')
  await refunds.forgiveDebt(u, 25, key, 'admin@test.invalid', 'same operation')
  expect((await credits.balanceOf(u)).debt).toBe(50)
  await expect(refunds.forgiveDebt(u, 51, randomUUID(), 'admin', 'reviewed')).rejects.toThrow('exceeds')
  expect((await pool.query('SELECT * FROM public.lb_credit_debt_entries WHERE entry_key=$1', [`admin:${key}`])).rows).toHaveLength(1)
})

test('expired worker lease recovers after restart and manual retries record the reviewer', async () => {
  const u = await user(), c = await pack(u), r = refund(c, 1000), evt = event('refund.created', r.id)
  await billing.apply(evt)
  await pool.query("UPDATE public.lb_billing_actions SET status='running',lease_until=now()-interval '1 second' WHERE action_key=$1", [`event:${evt.id}`])
  await refunds.retry()
  expect((await credits.balanceOf(u)).bonus).toBe(0)
  const unknown = event('charge.refunded', charge(u).id)
  await billing.apply(unknown); await refunds.retry()
  await refunds.retryReviewed(`event:${unknown.id}`, 'reviewer@test.invalid', 'checked records')
  expect((await pool.query('SELECT actor FROM public.lb_billing_admin_audit WHERE action_key=$1', [`event:${unknown.id}`])).rows[0].actor).toBe('reviewer@test.invalid')
})

test('wrong-mode refund events and customer mismatches never change a wallet', async () => {
  const u = await user(), c = await pack(u), r = refund(c, 1000)
  await expect(billing.apply({ ...event('refund.created', r.id), livemode: true })).rejects.toThrow('mode mismatch')
  c.customer = 'cus_foreign'
  await deliver(r)
  expect((await credits.balanceOf(u)).bonus).toBe(200)
})

test('concurrent spending and refunds serialize without negative balances or duplicated reversal', async () => {
  const u = await user(), c = await pack(u), r = refund(c, 1000)
  await billing.apply(event('refund.created', r.id))
  await Promise.all([spend(u, 75), refunds.retry(), refunds.retry(), billing.apply(event('charge.refunded', c.id))])
  await refunds.retry()
  const b = await credits.balanceOf(u)
  expect(b.bonus).toBe(0)
  expect([0, 75]).toContain(b.debt)
  expect((await pool.query('SELECT count(*)::int AS n FROM public.lb_credit_reversals WHERE user_id=$1', [u])).rows[0].n).toBe(1)
})

test.skipIf(!url)('real PostgreSQL refund disables login, terminates existing direct connections and keeps project data', async () => {
  const u = await user(), s = await sub(u), projectId = 'refund_' + randomUUID().replaceAll('-', '')
  const current = new URL(url!); current.pathname = '/' + database
  const directCfg = ConfigService.of({ ...cfg.env, DATABASE_URL: current.href, DATABASE_PUBLIC_HOST: current.hostname,
    DATABASE_PUBLIC_PORT: Number(current.port || 5432), DATABASE_PUBLIC_NAME: database, DATABASE_PUBLIC_SSLMODE: 'disable' })
  const direct = new DirectDatabaseService(pool, directCfg, schema, new LimitsService(pool, directCfg, schema))
  await pool.query('UPDATE public.lb_billing_control SET storage_ready=true WHERE id=1')
  await pool.query('INSERT INTO public.lb_projects(id,owner_id,ir) VALUES($1,$2,$3)', [projectId, u, '{}'])
  await pool.query(`CREATE SCHEMA "p_${projectId}"`)
  await pool.query(`CREATE TABLE "p_${projectId}".kept_data(id integer)`)
  await pool.query(`INSERT INTO "p_${projectId}".kept_data VALUES(1)`)
  const ctx = { user: { id: u }, project: { id: projectId } } as any
  const info = await direct.create(ctx)
  const readUrl = new URL(current); readUrl.username = info.username; readUrl.password = info.password
  const client = new pg.Client({ connectionString: readUrl.href })
  client.on('error', () => {}) // The refund intentionally terminates this session.
  try {
    await client.connect()
    expect((await client.query(`SELECT * FROM "p_${projectId}".kept_data`)).rows).toHaveLength(1)
    const handler = new RefundsService(pool, cfg, schema, direct, { refreshPriorities: async () => {} } as any)
    Object.assign(handler, { client: fake })
    const r = refund(s.c, 2500)
    await handler.accept(event('refund.created', r.id)); await handler.retry()
    expect((await pool.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [info.username])).rows[0].rolcanlogin).toBe(false)
    await expect(client.query('SELECT 1')).rejects.toThrow()
    expect((await pool.query(`SELECT * FROM "p_${projectId}".kept_data`)).rows).toHaveLength(1)
    expect((await pool.query('SELECT enabled FROM public.lb_direct_connections WHERE project_id=$1', [projectId])).rows[0].enabled).toBe(false)
  } finally {
    await client.end().catch(() => {})
    await pool.query(`DROP SCHEMA "p_${projectId}" CASCADE`)
    await pool.query(`DROP OWNED BY "${info.username}"`)
    await pool.query(`DROP ROLE "${info.username}"`)
  }
})
