import { Stripe } from 'stripe'
import { stripePreflight } from './lib/stripe-preflight'
import { STRIPE_API_VERSION } from '../src/modules/billing/stripe-contract'

try {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION })
  console.log(JSON.stringify(await stripePreflight(stripe, process.env), null, 2))
} catch (error) {
  // Stripe errors can include request fields. Never print their raw payload or stack.
  console.error(error instanceof Stripe.errors.StripeError ? `Stripe preflight failed (${error.type}); check Dashboard permissions/configuration` : error instanceof Error ? error.message : 'Stripe preflight failed')
  process.exitCode = 1
}
