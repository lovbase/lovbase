import type Stripe from 'stripe'
import { priceMatches, stripeCatalog, STRIPE_API_VERSION, STRIPE_EVENTS } from '../../src/modules/billing/stripe-contract'

/** Read-only. No customer, Checkout, payment or configuration is created here. */
export async function stripePreflight(stripe: Stripe, env: Record<string, string | undefined>) {
  const mode = env.STRIPE_MODE
  if (mode !== 'test' && mode !== 'live') throw new Error('Preflight requires STRIPE_MODE=test|live')
  if (!new RegExp(`^(sk|rk)_${mode}_`).test(env.STRIPE_SECRET_KEY ?? '')) throw new Error('Stripe key mode mismatch')
  const account = await stripe.accounts.retrieve(null)
  if (!env.STRIPE_ACCOUNT_ID || account.id !== env.STRIPE_ACCOUNT_ID) throw new Error('Stripe account mismatch')
  if (mode === 'live' && (!account.charges_enabled || !account.details_submitted)) throw new Error('Stripe account cannot accept live charges')
  const origin = new URL(env.BETTER_AUTH_URL ?? '')
  if (mode === 'live' && (origin.protocol !== 'https:' || origin.hostname === 'localhost' || !origin.hostname.includes('.') || origin.username || origin.password)) throw new Error('Live billing requires public HTTPS origin')
  for (const item of stripeCatalog) {
    if (!env[item.env]) throw new Error(`Missing ${item.env}`)
    const price = await stripe.prices.retrieve(env[item.env]!, { expand: ['product'] })
    if (!priceMatches(price, mode === 'live', item.amount, item.interval)) throw new Error(`Incorrect ${item.env}`)
    if (typeof price.product === 'string' || price.product.deleted || !price.product.active || price.product.livemode !== (mode === 'live')) throw new Error(`Inactive or wrong-mode product for ${item.env}`)
  }
  if (!env.STRIPE_PORTAL_CONFIGURATION) throw new Error('Missing STRIPE_PORTAL_CONFIGURATION')
  const portal = await stripe.billingPortal.configurations.retrieve(env.STRIPE_PORTAL_CONFIGURATION)
  if (!portal.active || portal.livemode !== (mode === 'live') || !portal.features.subscription_cancel.enabled
    || portal.features.subscription_cancel.mode !== 'at_period_end' || portal.features.subscription_update.enabled)
    throw new Error('Portal must be active, match mode and permit cancellation only at period end without plan switching')
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 })
  if (endpoints.has_more) throw new Error('More than 100 webhooks; inspect manually')
  const matches = endpoints.data.filter(endpoint => endpoint.url === `${origin.origin}/api/billing/webhook` && endpoint.status === 'enabled')
  if (matches.length !== 1) throw new Error('Expected exactly one enabled billing webhook')
  const endpoint = matches[0]
  if (endpoint.livemode !== (mode === 'live') || endpoint.api_version !== STRIPE_API_VERSION
    || endpoint.enabled_events.length !== STRIPE_EVENTS.length || STRIPE_EVENTS.some(e => !endpoint.enabled_events.includes(e)))
    throw new Error('Webhook mode, API version or event list mismatch')
  if (!env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) throw new Error('Missing webhook signing secret; delivery must also be verified')
  return { account: account.id, mode, webhook: endpoint.id, apiVersion: endpoint.api_version, prices: stripeCatalog.length }
}
