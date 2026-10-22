import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CREDIT_PACKS, PLANS } from '../../core/src/plans'

// CLI login uses the user's OAuth session; neither API keys nor signing secrets are printed.
function stripe(args: string[]) {
  const r = spawnSync('stripe', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`Stripe command failed: ${args.slice(0, 3).join(' ')}. Check stripe login.`)
  const json = JSON.parse(r.stdout)
  if (json.error) throw new Error(json.error.message)
  if (json.livemode === true || json.data?.some((v: { livemode?: boolean }) => v.livemode)) throw new Error('Only test-mode objects are allowed')
  return json
}
const path = fileURLToPath(new URL('../../app/.env', import.meta.url))
const updates: Record<string, string> = {}
updates.STRIPE_MODE = 'test'
updates.STRIPE_ACCOUNT_ID = stripe(['get', '/v1/account']).id
function setEnv(key: string, value: string) {
  updates[key] = value
}
const catalog = [
  { key: 'pro_monthly', name: 'Lovbase Pro', amount: PLANS.pro.price * 100, interval: 'month', env: 'STRIPE_PRICE_PRO_MONTHLY' },
  { key: 'pro_yearly', name: 'Lovbase Pro', amount: PLANS.pro.yearlyPrice * 12 * 100, interval: 'year', env: 'STRIPE_PRICE_PRO_YEARLY' },
  ...CREDIT_PACKS.map(p => ({ key: `credits_${p.id}`, name: `Lovbase ${p.credits} credits`, amount: p.price * 100, interval: '', env: `STRIPE_PRICE_CREDITS_${p.id.toUpperCase()}` })),
]
const products = stripe(['products', 'list', '--limit', '100'])
if (products.has_more) throw new Error('Too many products for automatic setup')
for (const item of catalog) {
  const lookup = `lovbase_${item.key}_v1`
  const found = stripe(['prices', 'list', '-d', `lookup_keys[]=${lookup}`, '--limit', '2'])
  let price = found.data[0]
  if (!price) {
    const productKey = item.key.startsWith('pro_') ? 'pro' : item.key
    let product = products.data.find((p: { metadata?: Record<string, string> }) => p.metadata?.lovbase_product === productKey)
    if (!product) {
      product = stripe(['products', 'create', '-d', `name=${item.name}`, '-d', `metadata[lovbase_product]=${productKey}`, '--idempotency', `lovbase-test-product-${productKey}`])
      products.data.push(product)
    }
    const args = ['prices', 'create', '-d', `product=${product.id}`, '-d', 'currency=usd', '-d', `unit_amount=${item.amount}`, '-d', `lookup_key=${lookup}`, '-d', 'tax_behavior=exclusive', '--idempotency', `lovbase-test-price-${lookup}`]
    if (item.interval) args.push('-d', `recurring[interval]=${item.interval}`)
    price = stripe(args)
  }
  if (!price.active || price.currency !== 'usd' || price.unit_amount !== item.amount || (price.recurring?.interval ?? '') !== item.interval || (price.recurring && price.recurring.interval_count !== 1))
    throw new Error(`Existing price ${lookup} differs from plans.ts`)
  setEnv(item.env, price.id)
  console.log(`${item.key}: $${(item.amount / 100).toFixed(2)}${item.interval ? `/${item.interval}` : ''} (${price.id})`)
}
const portals = stripe(['billing_portal', 'configurations', 'list', '--limit', '100'])
if (portals.has_more) throw new Error('Too many portal configurations for automatic setup')
let portal = portals.data.find((p: { metadata?: Record<string, string> }) => p.metadata?.lovbase === 'test-v1')
if (!portal) portal = stripe(['billing_portal', 'configurations', 'create',
  '-d', 'name=Lovbase test portal', '-d', 'metadata[lovbase]=test-v1',
  '-d', 'features[customer_update][enabled]=true', '-d', 'features[customer_update][allowed_updates][]=email',
  '-d', 'features[invoice_history][enabled]=true', '-d', 'features[payment_method_update][enabled]=true',
  '-d', 'features[subscription_cancel][enabled]=true', '-d', 'features[subscription_cancel][mode]=at_period_end',
  '-d', 'features[subscription_update][enabled]=false', '--idempotency', 'lovbase-test-portal-v1'])
setEnv('STRIPE_PORTAL_CONFIGURATION', portal.id)
let contents = readFileSync(path, 'utf8')
for (const [key, value] of Object.entries(updates)) {
  const re = new RegExp(`^${key}=.*$`, 'm')
  contents = re.test(contents) ? contents.replace(re, `${key}=${value}`) : `${contents.trimEnd()}\n${key}=${value}\n`
}
writeFileSync(path, contents, { mode: 0o600 })
chmodSync(path, 0o600)
console.log('Test prices and portal configuration saved to app/.env. No live objects created.')
