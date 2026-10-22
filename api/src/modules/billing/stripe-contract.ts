import { CREDIT_PACKS, PLANS } from '@lovbase/core/plans'

// Keep the endpoint snapshot shape aligned with the installed SDK, including local forwarding.
export const STRIPE_API_VERSION = '2026-09-30.endive' as const
export const STRIPE_EVENTS = [
  'checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed', 'checkout.session.expired',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed',
] as const
export const stripeCatalog = [
  { key: 'pro_monthly', name: 'Lovbase Pro', amount: PLANS.pro.price * 100, interval: 'month' as const, env: 'STRIPE_PRICE_PRO_MONTHLY' },
  { key: 'pro_yearly', name: 'Lovbase Pro', amount: PLANS.pro.yearlyPrice * 1200, interval: 'year' as const, env: 'STRIPE_PRICE_PRO_YEARLY' },
  ...CREDIT_PACKS.map(p => ({ key: `credits_${p.id}`, name: `Lovbase ${p.credits} credits`, amount: p.price * 100, interval: undefined, env: `STRIPE_PRICE_CREDITS_${p.id.toUpperCase()}` })),
]
export function priceMatches(price: { active: boolean; livemode: boolean; currency: string; unit_amount: number | null; tax_behavior?: string | null; recurring?: { interval: string; interval_count: number } | null }, live: boolean, amount: number, interval?: string) {
  return price.active && price.livemode === live && price.currency === 'usd' && price.unit_amount === amount && price.tax_behavior !== 'inclusive'
    && (interval ? price.recurring?.interval === interval && price.recurring.interval_count === 1 : !price.recurring)
}
