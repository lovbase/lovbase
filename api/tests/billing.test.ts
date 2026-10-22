import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { Stripe } from 'stripe'
import type pg from 'pg'
import { ConfigService } from '../src/config/config.service'
import { SchemaService } from '../src/database/schema.service'
import { BillingService } from '../src/modules/billing/billing.service'
import { CreditsService } from '../src/modules/credits/credits.service'
import { AccountsService } from '../src/modules/accounts/accounts.service'

const db = new PGlite()
let tail = Promise.resolve()
async function acquire() { const before = tail; let release!: () => void; tail = new Promise(r => { release = r }); await before; return release }
async function query(sql: string, params?: unknown[]) { const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows || r.rows.length } }
const pool = { query, connect: async () => { const release = await acquire(); return { query, release } } } as unknown as pg.Pool
const schema = new SchemaService(pool)
const credits = new CreditsService(pool, schema)
const accounts = new AccountsService(pool, schema)
const cfg = ConfigService.of({
  STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', BETTER_AUTH_URL: 'http://localhost:3008',
  STRIPE_PRICE_PRO_MONTHLY: 'price_month', STRIPE_PRICE_PRO_YEARLY: 'price_year',
  STRIPE_PRICE_CREDITS_SMALL: 'price_small', STRIPE_PRICE_CREDITS_MEDIUM: 'price_medium', STRIPE_PRICE_CREDITS_LARGE: 'price_large',
})
let sequence = 0
beforeAll(async () => { await schema.ready() }, 30_000)
afterAll(async () => { await db.close() })

async function fixture() {
  const id = `billing${++sequence}`, customer = `cus_${id}`
  await query('INSERT INTO public."user"(id,name,email,"createdAt","updatedAt",stripe_customer_id) VALUES($1,$1,$2,now(),now(),$3)', [id, `${id}@test.invalid`, customer])
  const sessions = new Map<string, any>()
  const subscriptions: any[] = []
  const invoices = new Map<string, any>()
  let created = 0, customers = 0
  const fake = {
    customers: { create: async () => { customers++; return { id: customer } } },
    prices: { retrieve: async (price: string) => ({ id: price, active: true, currency: 'usd', tax_behavior: 'exclusive', unit_amount: { price_month: 2500, price_year: 24000, price_small: 1000, price_medium: 4500, price_large: 20000 }[price], recurring: price === 'price_year' ? { interval: 'year', interval_count: 1 } : price === 'price_month' ? { interval: 'month', interval_count: 1 } : null }) },
    subscriptions: { list: async () => ({ data: subscriptions, has_more: false }) },
    invoices: {
      list: async ({ subscription }: any) => ({ data: invoices.has(subscription) ? [invoices.get(subscription)] : [], has_more: false }),
      listLineItems: async (invoice: string) => ({ data: [...invoices.values()].find(v => v.id === invoice)?.lines ?? [], has_more: false }),
    },
    checkout: { sessions: {
      list: async () => ({ data: [...sessions.values()].filter(s => s.status === 'open'), has_more: false }),
      create: async (params: any) => {
        created++
        const session = { id: `cs_test_${id}_${created}`, customer, status: 'open', payment_status: 'unpaid', currency: 'usd', url: `https://checkout.stripe.com/test_${id}_${created}`, ...params }
        sessions.set(session.id, session)
        return session
      },
      retrieve: async (sid: string) => { if (!sessions.has(sid)) throw new Error('Unknown session'); return sessions.get(sid) },
      expire: async (sid: string) => { sessions.get(sid).status = 'expired'; return sessions.get(sid) },
      listLineItems: async (sid: string) => ({ data: sessions.get(sid).line_items.map((l: any) => ({ price: { id: l.price }, quantity: l.quantity })), has_more: false }),
    } },
    billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.com/test_portal' }) } },
  }
  const service = new BillingService(pool, cfg, schema, {reconcile:async()=>{}} as any, {refreshPriorities:async()=>{}} as any)
  Object.assign(service, { client: fake })
  function event(type: string, object: any, eventId = `evt_${++sequence}`) { return { id: eventId, type, data: { object } } as Stripe.Event }
  function paidSubscription(yearly = false) {
    const start = Math.floor(Date.now() / 1000) - 60, end = start + (yearly ? 365 : 30) * 86400
    const sub = { id: `sub_${id}`, customer, created: start, status: 'active', cancel_at_period_end: false, items: { data: [{ price: { id: yearly ? 'price_year' : 'price_month', recurring: { interval: yearly ? 'year' : 'month' } } }] } }
    subscriptions.push(sub)
    invoices.set(sub.id, { id: `in_${id}`, status: 'paid', lines: [{ pricing: { price_details: { price: sub.items.data[0].price.id } }, parent: { type: 'subscription_item_details', subscription_item_details: { proration: false } }, period: { start, end } }] })
    return { sub, start, end }
  }
  return { id, customer, user: { id, email: `${id}@test.invalid` }, service, sessions, subscriptions, invoices, fake, event, paidSubscription, counts: () => ({ created, customers }) }
}

describe('Stripe checkout and account ownership', () => {
  test('concurrent checkout requests reuse one customer and one session, with canonical return URL', async () => {
    const f = await fixture()
    await query('UPDATE public."user" SET stripe_customer_id=NULL WHERE id=$1', [f.id])
    const urls = await Promise.all([f.service.checkoutUrl(f.user, 'pro', false), f.service.checkoutUrl(f.user, 'pro', false)])
    expect(urls[0]).toBe(urls[1])
    expect(f.counts()).toEqual({ created: 1, customers: 1 })
    const session = [...f.sessions.values()][0]
    expect(session.success_url).toBe('http://localhost:3008/settings?checkout={CHECKOUT_SESSION_ID}')
    await expect(f.service.checkoutStatus('someone-else', session.id)).rejects.toThrow('Payment not found')
  })
  test('billing toggle expires the previous session and active subscribers go to Portal', async () => {
    const f = await fixture()
    await f.service.checkoutUrl(f.user, 'pro', false)
    const old = [...f.sessions.values()][0]
    await f.service.checkoutUrl(f.user, 'pro', true)
    expect(old.status).toBe('expired')
    f.paidSubscription()
    expect(await f.service.checkoutUrl(f.user, 'pro', false)).toContain('billing.stripe.com')
    await expect(f.service.checkoutUrl(f.user, 'business', false)).rejects.toThrow('self-service')
  })
  test('an open checkout with an outdated price is expired instead of reused', async () => {
    const f = await fixture()
    await f.service.creditCheckoutUrl(f.user, 'small')
    const old = [...f.sessions.values()][0]
    old.line_items[0].price = 'price_retired'
    const next = await f.service.creditCheckoutUrl(f.user, 'small')
    expect(old.status).toBe('expired')
    expect(next).not.toBe(old.url)
    expect(f.counts().created).toBe(2)
  })
  test('a misconfigured Stripe price cannot charge a different amount', async () => {
    const f = await fixture()
    f.fake.prices.retrieve = async () => ({ active: true, currency: 'usd', unit_amount: 1 }) as any
    await expect(f.service.checkoutUrl(f.user, 'pro', false)).rejects.toThrow('advertised price')
    expect(f.counts().created).toBe(0)
  })
})

describe('webhooks grant paid rights once, in a database transaction', () => {
  for (const [pack, amount] of [['small', 200], ['medium', 1000], ['large', 5000]] as const) {
    test(`${pack} pack: unpaid does not grant; paid and duplicate events grant exactly once`, async () => {
      const f = await fixture()
      await f.service.creditCheckoutUrl(f.user, pack)
      const session = [...f.sessions.values()][0]
      session.status = 'complete'
      await f.service.apply(f.event('checkout.session.completed', session))
      expect((await credits.balanceOf(f.id)).bonus).toBe(0)
      session.payment_status = 'paid'
      const event = f.event('checkout.session.async_payment_succeeded', session)
      await f.service.apply(event)
      await f.service.apply(event)
      await f.service.apply(f.event('checkout.session.completed', session))
      await f.service.apply(f.event('checkout.session.async_payment_failed', session))
      expect((await credits.balanceOf(f.id)).bonus).toBe(amount)
      expect(await f.service.checkoutStatus(f.id, session.id)).toBe('complete')
      expect((await query('SELECT * FROM public.lb_credit_grants WHERE user_id=$1', [f.id])).rowCount).toBe(1)
    })
  }
  test('a transaction failure remains retryable and never half-grants a pack', async () => {
    const f = await fixture()
    await f.service.creditCheckoutUrl(f.user, 'small')
    const session = [...f.sessions.values()][0]
    session.payment_status = 'paid'
    session.line_items[0].price = 'price_wrong'
    const event = f.event('checkout.session.completed', session)
    await expect(f.service.apply(event)).rejects.toThrow('product mismatch')
    expect((await query('SELECT * FROM public.lb_billing_events WHERE id=$1', [event.id])).rowCount).toBe(0)
    expect((await credits.balanceOf(f.id)).bonus).toBe(0)
    session.line_items[0].price = 'price_small'
    await f.service.apply(event)
    expect((await credits.balanceOf(f.id)).bonus).toBe(200)
  })
  test('an async failure or expired checkout is shown as failed without granting', async () => {
    const f = await fixture()
    await f.service.creditCheckoutUrl(f.user, 'small')
    const session = [...f.sessions.values()][0]
    await f.service.apply(f.event('checkout.session.async_payment_failed', session))
    expect(await f.service.checkoutStatus(f.id, session.id)).toBe('failed')
    expect((await credits.balanceOf(f.id)).bonus).toBe(0)
  })
  test('paid invoices set coverage; subscription edits and retries never reset used credits', async () => {
    const f = await fixture()
    const { sub, start, end } = f.paidSubscription(true)
    await credits.grant(f.id, 200)
    await f.service.apply(f.event('invoice.paid', { id: 'in_test', customer: f.customer }))
    await credits.charge(f.id, { kind: 'message', credits: 123 })
    const before = await credits.balanceOf(f.id)
    // Current Portal schedules cancel_at without setting the legacy boolean.
    Object.assign(sub, { cancel_at: end })
    await f.service.apply(f.event('customer.subscription.updated', sub))
    const after = await credits.balanceOf(f.id)
    expect(after.used).toBe(123)
    expect(after.included).toBe(500)
    expect(after.bonus).toBe(200)
    expect(after.periodStart).toBe(before.periodStart)
    const status = await f.service.subscriptionOf(f.id)
    expect(status.interval).toBe('year')
    expect(status.paidUntil).toBe(new Date(end * 1000).toISOString())
    expect(new Date(after.periodStart).getTime()).toBe(start * 1000)
    expect(status.cancelAtPeriodEnd).toBe(true)
  })
  test('monthly credits use exact paid invoice boundaries after a short month', async () => {
    const f = await fixture()
    const { sub } = f.paidSubscription()
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59))
    f.invoices.get(sub.id).lines[0].period = { start: start.getTime() / 1000, end: end.getTime() / 1000 }
    await f.service.apply(f.event('invoice.paid', { customer: f.customer }))
    const balance = await credits.balanceOf(f.id)
    expect(balance.periodStart).toBe(start.toISOString())
    expect(balance.periodEnd).toBe(end.toISOString())
  })
  test('unpaid renewal never extends coverage, which expires even before another webhook', async () => {
    const f = await fixture()
    const { sub } = f.paidSubscription()
    await f.service.apply(f.event('invoice.paid', { customer: f.customer }))
    f.invoices.clear()
    sub.status = 'past_due'
    await f.service.apply(f.event('invoice.payment_failed', { customer: f.customer }))
    expect((await accounts.get(f.id))?.plan).toBe('pro')
    await query('UPDATE public."user" SET stripe_paid_until=now()-interval \'1 second\' WHERE id=$1', [f.id])
    expect((await accounts.get(f.id))?.plan).toBe('free')
    expect((await accounts.identity(f.id))?.plan).toBe('free')
    expect((await credits.balanceOf(f.id)).included).toBe(30)
  })
  test('cancellation preserves already paid coverage and an old cancellation cannot undo a newer subscription', async () => {
    const f = await fixture()
    const { sub } = f.paidSubscription()
    await f.service.apply(f.event('invoice.paid', { customer: f.customer }))
    sub.status = 'canceled'
    await f.service.apply(f.event('customer.subscription.deleted', sub))
    expect((await accounts.get(f.id))?.plan).toBe('pro')
    const next = { ...sub, id: 'sub_new', created: sub.created + 1, status: 'active' }
    f.subscriptions.push(next)
    f.invoices.set(next.id, { ...f.invoices.get(sub.id), id: 'in_new' })
    await f.service.apply(f.event('invoice.paid', { customer: f.customer }))
    await f.service.apply(f.event('customer.subscription.deleted', sub))
    expect((await f.service.subscriptionOf(f.id)).id).toBe('sub_new')
    expect((await accounts.get(f.id))?.plan).toBe('pro')
  })
  test('a newer unpaid subscription cannot replace existing paid coverage', async () => {
    const f = await fixture()
    const { sub } = f.paidSubscription()
    await f.service.apply(f.event('invoice.paid', { customer: f.customer }))
    f.subscriptions.push({ ...sub, id: 'sub_unpaid', created: sub.created + 1, status: 'incomplete' })
    await f.service.apply(f.event('customer.subscription.created', { customer: f.customer }))
    expect((await f.service.subscriptionOf(f.id)).id).toBe(sub.id)
    expect((await accounts.get(f.id))?.plan).toBe('pro')
  })
  test('future paid coverage does not grant rights early', async () => {
    const f = await fixture()
    const { sub } = f.paidSubscription(true)
    const invoice = f.invoices.get(sub.id)
    invoice.lines[0].period.start += 86400
    await f.service.apply(f.event('invoice.paid', { customer: f.customer }))
    expect((await accounts.get(f.id))?.plan).toBe('free')
    expect((await accounts.identity(f.id))?.plan).toBe('free')
    expect((await credits.balanceOf(f.id)).included).toBe(30)
  })
  test('a subscription with no paid invoice has no paid rights', async () => {
    const f = await fixture()
    const { sub } = f.paidSubscription()
    f.invoices.clear()
    await f.service.apply(f.event('customer.subscription.created', sub))
    expect((await accounts.get(f.id))?.plan).toBe('free')
  })
})

test('official SDK checks raw bytes, timestamp tolerance, multiple signatures and malformed JSON', async () => {
  const sdk = new Stripe('sk_test_signature')
  const service = new BillingService(pool, cfg, schema, {reconcile:async()=>{}} as any, {refreshPriorities:async()=>{}} as any)
  const payload = JSON.stringify({ id: 'evt_signed', object: 'event', type: 'invoice.paid', data: { object: {} } })
  const header = await sdk.webhooks.generateTestHeaderStringAsync({ payload, secret: 'whsec_fixture' })
  expect((await service.parseWebhook(Buffer.from(payload), `v1=invalid,${header}`)).id).toBe('evt_signed')
  await expect(service.parseWebhook(Buffer.from(`${payload} `), header)).rejects.toThrow()
  await expect(service.parseWebhook(Buffer.from(payload), undefined)).rejects.toThrow()
  const expired = await sdk.webhooks.generateTestHeaderStringAsync({ payload, secret: 'whsec_fixture', timestamp: Math.floor(Date.now() / 1000) - 600 })
  await expect(service.parseWebhook(Buffer.from(payload), expired)).rejects.toThrow()
  const malformed = '{'
  const signedMalformed = await sdk.webhooks.generateTestHeaderStringAsync({ payload: malformed, secret: 'whsec_fixture' })
  await expect(service.parseWebhook(Buffer.from(malformed), signedMalformed)).rejects.toThrow()
})


test('builder checkout returns to the project and does not reuse a checkout for another return path',async()=>{
  const f=await fixture()
  await f.service.checkoutUrl({id:f.id,email:'test@example.invalid'},'pro',false,'/projects/builder?app=one')
  const first=[...f.sessions.values()][0]
  expect(first.success_url).toBe('http://localhost:3008/projects/builder?app=one&checkout={CHECKOUT_SESSION_ID}')
  expect(first.cancel_url).toBe('http://localhost:3008/projects/builder?app=one&canceled=1')
  await f.service.checkoutUrl({id:f.id,email:'test@example.invalid'},'pro',false,'/home')
  expect([...f.sessions.values()].filter((s:any)=>s.status==='open')).toHaveLength(1)
  await expect(f.service.checkoutUrl({id:f.id,email:'test@example.invalid'},'pro',false,'//evil.test')).rejects.toThrow()
})

test('pricing Checkout returns preserve billing choice for both payment outcomes', async () => {
  for (const yearly of [false, true]) {
    const f = await fixture()
    const path = `/pricing?billing=${yearly ? 'yearly' : 'monthly'}`
    await f.service.checkoutUrl(f.user, 'pro', yearly, path)
    const session = [...f.sessions.values()][0]
    expect(session.success_url).toBe(`http://localhost:3008${path}&checkout={CHECKOUT_SESSION_ID}`)
    expect(session.cancel_url).toBe(`http://localhost:3008${path}&canceled=1`)
    expect(session.metadata.returnPath).toBe(path)
  }
})
