import { Stripe } from 'stripe'
import { STRIPE_API_VERSION, STRIPE_EVENTS } from '../src/modules/billing/stripe-contract'

// Read-only by default. Run --apply only AFTER the corresponding Web and Worker release is healthy.
try {
  const env = process.env
  if (!['test', 'live'].includes(env.STRIPE_MODE ?? '') || !env.STRIPE_SECRET_KEY || !env.STRIPE_ACCOUNT_ID)
    throw new Error('Explicit Stripe mode, account and key required')
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2 })
  const account = await stripe.accounts.retrieve(null)
  if (account.id !== env.STRIPE_ACCOUNT_ID) throw new Error('Stripe account mismatch')
  const origin = new URL(env.BETTER_AUTH_URL ?? '')
  if (env.STRIPE_MODE === 'live' && origin.origin !== 'https://lovbase.dev') throw new Error('Unexpected Live origin')
  const list = await stripe.webhookEndpoints.list({ limit: 100 })
  const endpoints = list.data.filter(e => e.url === `${origin.origin}/api/billing/webhook` && e.livemode === (env.STRIPE_MODE === 'live'))
  if (list.has_more || endpoints.length !== 1) throw new Error('Exactly one matching webhook is required')
  const endpoint = endpoints[0]
  if (endpoint.api_version !== STRIPE_API_VERSION || endpoint.status !== 'enabled') throw new Error('Endpoint API version or status requires manual review')
  const missing = STRIPE_EVENTS.filter(e => !endpoint.enabled_events.includes(e))
  const extra = endpoint.enabled_events.filter(e => !(STRIPE_EVENTS as readonly string[]).includes(e))
  console.log(JSON.stringify({ endpoint: endpoint.id, mode: env.STRIPE_MODE, missing, extra, apply: process.argv.includes('--apply') }))
  if (process.argv.includes('--apply') && (missing.length || extra.length)) {
    await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: [...STRIPE_EVENTS] })
    console.log('Webhook event list synchronized. Signing secret unchanged.')
  }
} catch (error) {
  console.error(error instanceof Stripe.errors.StripeError ? `Webhook synchronization failed (${error.type}); inspect Stripe Dashboard` : error instanceof Error ? error.message : 'Webhook synchronization failed')
  process.exitCode = 1
}
