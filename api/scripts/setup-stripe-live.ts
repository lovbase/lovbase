import { Stripe } from 'stripe'
import { writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripeCatalog, STRIPE_API_VERSION, STRIPE_EVENTS } from '../src/modules/billing/stripe-contract'
import { stripePreflight } from './lib/stripe-preflight'

// Run with a Live key injected by the deployment platform, never a CLI argument or app/.env.
// Output is a private cutover artifact; upload it to the platform without printing its contents.
try {
  const output = process.argv[2]
  if (!output || !isAbsolute(output) || resolve(output).startsWith(fileURLToPath(new URL('../../', import.meta.url)))) throw new Error('Provide an absolute output JSON path outside the repository')
  if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) throw new Error('Live setup requires STRIPE_SECRET_KEY=sk_live_… from the deployment environment')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2 })
  const account = await stripe.accounts.retrieve(null)
  if (account.id !== process.env.STRIPE_ACCOUNT_ID || !account.charges_enabled || !account.details_submitted) throw new Error('Live account is not activated or does not match STRIPE_ACCOUNT_ID')
  const origin = new URL(process.env.BETTER_AUTH_URL ?? '')
  if (origin.origin !== 'https://lovbase.dev') throw new Error('Live setup is restricted to https://lovbase.dev')
  const saved: Record<string, string> = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {}
  if (saved.STRIPE_ACCOUNT_ID && saved.STRIPE_ACCOUNT_ID !== account.id) throw new Error('Output belongs to another account')
  const updates = { ...saved, STRIPE_ACCOUNT_ID: account.id, STRIPE_MODE: 'live' } as Record<string, string>
  const save = () => { writeFileSync(output, JSON.stringify(updates, null, 2) + '\n', { mode: 0o600 }); chmodSync(output, 0o600) }
  for (const item of stripeCatalog) {
    const lookup = `lovbase_${item.key}_v1`
    const found = await stripe.prices.list({ lookup_keys: [lookup], limit: 2 })
    let price = found.data[0]
    if (!price) {
      const productKey = item.key.startsWith('pro_') ? 'pro' : item.key
      // Stable product IDs make creation reusable beyond Stripe's 24-hour idempotency window.
      const productId = `lovbase_${productKey}_v1`
      let product: Stripe.Product
      try { product = await stripe.products.retrieve(productId) as Stripe.Product }
      catch (error) {
        if (!(error instanceof Stripe.errors.StripeInvalidRequestError) || error.code !== 'resource_missing') throw error
        product = await stripe.products.create({ id: productId, name: item.name, metadata: { lovbase_product: productKey } })
      }
      if (!product.active || !product.livemode) throw new Error(`Inactive Live product ${productKey}`)
      price = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: item.amount,
        lookup_key: lookup, tax_behavior: 'exclusive', ...(item.interval ? { recurring: { interval: item.interval } } : {}) }, { idempotencyKey: `lovbase-live-price-${lookup}` })
    }
    updates[item.env] = price.id
    save()
  }
  const portals = await stripe.billingPortal.configurations.list({ limit: 100 })
  if (portals.has_more) throw new Error('Too many portal configurations')
  const portal = portals.data.find(p => p.metadata?.lovbase === 'live-v1') ?? await stripe.billingPortal.configurations.create({
    name: 'Lovbase Live portal', metadata: { lovbase: 'live-v1' },
    features: { customer_update: { enabled: true, allowed_updates: ['email'] }, invoice_history: { enabled: true },
      payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'at_period_end' }, subscription_update: { enabled: false } },
  }, { idempotencyKey: 'lovbase-live-portal-v1' })
  updates.STRIPE_PORTAL_CONFIGURATION = portal.id
  save()
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 })
  if (endpoints.has_more) throw new Error('Too many webhooks')
  const url = `${origin.origin}/api/billing/webhook`
  const existing = endpoints.data.filter(e => e.url === url)
  if (existing.length > 1) throw new Error('Duplicate billing webhooks; resolve manually')
  if (!existing.length) {
    const endpoint = await stripe.webhookEndpoints.create({ url, api_version: STRIPE_API_VERSION,
      enabled_events: [...STRIPE_EVENTS], metadata: { lovbase: 'live-v1' } }, { idempotencyKey: 'lovbase-live-webhook-v1' })
    if (!endpoint.secret) throw new Error('Stripe did not return a webhook signing secret')
    updates.STRIPE_WEBHOOK_SECRET = endpoint.secret
    save()
  } else if (!updates.STRIPE_WEBHOOK_SECRET) {
    if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('Existing endpoint secret cannot be recovered; supply it securely from Dashboard')
    updates.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET
    save()
  }
  console.log(JSON.stringify(await stripePreflight(stripe, { ...process.env, ...updates }), null, 2))
  console.log('Live catalog configuration saved privately. Payments remain disabled until deployment cutover.')
} catch (error) {
  console.error(error instanceof Stripe.errors.StripeError ? `Live setup failed (${error.type}); inspect Stripe Dashboard` : error instanceof Error ? error.message : 'Live setup failed')
  process.exitCode = 1
}
