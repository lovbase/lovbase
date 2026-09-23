import { CREDIT_PACKS, PLANS, type CreditPack, type Plan, type PlanSpec } from './plans'

// ── What a credit is ──
//
// A credit used to mean "one conversation", which is not a unit of anything: one turn can be a
// five-token question or ten tool steps over a 40k-character file. Selling those at the same price
// is how you lose money without being able to see it happening.
//
// A credit is now a fixed amount of *real spend*. Everything below exists to turn measured usage —
// tokens at a model's price, seconds of container time — into that unit, and to make the plan
// allowances checkable against revenue instead of chosen by feel.

/** One credit buys this much underlying cost. Changing it re-prices every plan; see `planMargin`. */
export const CREDIT_USD = 0.01

export type Tier = 'fast' | 'standard' | 'advanced'

export const TIERS: Tier[] = ['fast', 'standard', 'advanced']

export const TIER_LABEL: Record<Tier, { zh: string; en: string }> = {
  fast: { zh: '快速', en: 'Fast' },
  standard: { zh: '标准', en: 'Standard' },
  advanced: { zh: '高级', en: 'Advanced' },
}

/**
 * Markup applied on top of measured cost, per tier.
 *
 * This is the knob to turn when margin is wrong — it never makes the platform less safe, because
 * it only ever charges the user *more* credits than the spend they caused. Headroom for the things
 * that are not metered: retries, the request that failed after burning tokens, egress.
 */
export const TIER_MARGIN: Record<Tier, number> = {
  fast: 1.3,
  standard: 1.5,
  advanced: 1.8,
}

/** List price of a model, per million tokens, before the tier markup. */
export type ModelRate = { tier: Tier; inPer1M: number; outPer1M: number }

/**
 * Starting point only — an admin edits this table at runtime (Admin → Billing), because provider
 * prices move and which model sits in which tier is a business call, not a constant.
 *
 * The numbers here are deliberately pessimistic. Being wrong in the expensive direction costs a
 * user a few extra credits; being wrong in the cheap direction costs real money on every turn.
 */
export const DEFAULT_MODEL_RATES: Record<string, ModelRate> = {
  'gpt-5.6-sol': { tier: 'standard', inPer1M: 3, outPer1M: 15 },
  'claude-sonnet-5': { tier: 'standard', inPer1M: 3, outPer1M: 15 },
  'claude-opus-5': { tier: 'advanced', inPer1M: 15, outPer1M: 75 },
  'claude-haiku-4-5-20251001': { tier: 'fast', inPer1M: 1, outPer1M: 5 },
}

/**
 * A model nobody configured. Priced as the most expensive tier on purpose: an unknown model is a
 * model whose bill you have not seen, and guessing cheap is how the gap opens up silently.
 */
export const FALLBACK_RATE: ModelRate = { tier: 'advanced', inPer1M: 15, outPer1M: 75 }

export const rateFor = (model: string, table: Record<string, ModelRate> = DEFAULT_MODEL_RATES): ModelRate =>
  table[model] ?? FALLBACK_RATE

// ── Everything that is not tokens ──
//
// Every number in this block is a placeholder to be replaced from an actual invoice. They are set
// pessimistically, because the failure mode of guessing low is a bill you only notice at the end
// of the month. What matters here is that each cost driver has a line rather than being forgotten.

/**
 * Sandbox containers, per wall-clock minute of a `standard-1` instance (½ vCPU, 4 GiB, 8 GB disk).
 *
 * Memory and disk are billed on *provisioned* resources for as long as the instance exists;
 * CPU is billed on *active* time only. So an idle container costs
 * 4 GiB × $0.0000025 + 8 GB × $0.00000007 ≈ $0.00063 a minute, and a busy one adds at most
 * ½ × $0.00002 × 60 ≈ $0.0006 more. This constant is the standing half; CPU-heavy work is
 * roughly double it.
 *
 * Active-CPU billing is the reason this workload is cheap: an agent sandbox is busy for minutes
 * and idle for hours, and the idle hours cost almost nothing.
 */
export const CONTAINER_USD_PER_MIN = 0.0013

/**
 * A preview keeps a container alive for the idle window even after the tab is closed, so opening
 * one costs that whole window whether or not anybody watches. Keep in step with SANDBOX_SLEEP_AFTER.
 */
export const PREVIEW_WINDOW_MIN = 5

/** Managed Postgres, per GB per month. This is a standing cost: the tenant pays it while idle. */
export const DB_STORAGE_USD_PER_GB_MONTH = 0.25

/** Object storage holding published apps. Small per app, but it never stops. */
export const PUBLISHED_STORAGE_USD_PER_GB_MONTH = 0.015

/** Typical built size of one published app. */
export const PUBLISHED_APP_GB = 0.01

/**
 * Egress, per GB, for the *hosted* product.
 *
 * Zero, because published apps are served from R2 and R2 does not charge for egress. That is not a
 * detail — it is load-bearing. At $0.09/GB the Business tier's 500 GB allowance costs $45 against
 * $79 of revenue and the plan goes to a negative margin before a single token is spent.
 *
 * So: moving the published copy off R2 is a pricing decision, not just an infrastructure one, and
 * the plan table has to be recomputed the day it happens. The budget test below is what will say so.
 *
 * Self-hosters pay their own bandwidth; that is their bill, not a cost of goods here.
 */
export const EGRESS_USD_PER_GB = 0

export type Usage = { inTokens: number; outTokens: number }

/** Raw provider cost of one exchange, before any markup. */
export const tokenCostUsd = (u: Usage, rate: ModelRate) =>
  (u.inTokens / 1_000_000) * rate.inPer1M + (u.outTokens / 1_000_000) * rate.outPer1M

export const containerCostUsd = (seconds: number) => (seconds / 60) * CONTAINER_USD_PER_MIN

/** One preview open, priced as the full idle window because that is what it reserves. */
export const previewCostUsd = () => PREVIEW_WINDOW_MIN * CONTAINER_USD_PER_MIN

/** Never free: a turn that somehow measured zero still consumed a slot and a request. */
const atLeastOne = (n: number) => Math.max(1, Math.ceil(n))

/**
 * Credits for model usage. `byok` zeroes it — the user paid the provider directly, so charging
 * them again for it is charging twice for one thing, and it punishes the only behaviour that
 * lowers the platform's bill.
 */
export function creditsForTokens(
  u: Usage,
  rate: ModelRate,
  opts: { byok?: boolean; margin?: number } = {},
): number {
  if (opts.byok) return 0
  return atLeastOne((tokenCostUsd(u, rate) * (opts.margin ?? TIER_MARGIN[rate.tier])) / CREDIT_USD)
}

/** Credits for container time. Charged to BYOK users too: that hardware is still ours. */
export function creditsForContainer(seconds: number, tier: Tier = 'standard', margin?: number): number {
  return atLeastOne((containerCostUsd(seconds) * (margin ?? TIER_MARGIN[tier])) / CREDIT_USD)
}

/** Credits for opening a preview on a cold container. A warm reopen reserves nothing new and is free. */
export function creditsForPreview(tier: Tier = 'standard', margin?: number): number {
  return atLeastOne((previewCostUsd() * (margin ?? TIER_MARGIN[tier])) / CREDIT_USD)
}

// ── The guarantee ──
//
// The point of denominating credits in money is that "will this plan lose money" stops being a
// feeling. A plan's whole allowance, spent at the worst rate, is its cost ceiling; compare that
// against what the plan actually earns and the answer is arithmetic.

/** Card fees come off the top before any of it is ours. */
export const PAYMENT_FEE_RATE = 0.035

/** The most of a paid plan's revenue that may go to model and container cost. */
export const MAX_COGS_RATIO = 0.35

/** A free user is an acquisition cost, so it is capped in absolute terms rather than as a ratio. */
export const FREE_COGS_CEILING_USD = 0.5

/**
 * What a plan costs every month even if the user never sends a message: the data they are allowed
 * to store, the apps they are allowed to keep published, and the bandwidth those apps may serve.
 *
 * This is the half that credits cannot cover. A credit allowance bounds what someone can *do*;
 * it says nothing about what they are allowed to *keep*, and a full 50 GB tenant costs the same
 * whether they log in or not. Anything standing therefore needs a per-plan ceiling, or the plan
 * has no worst case at all.
 */
export const planStandingUsd = (p: PlanSpec) =>
  (p.storageMb / 1024) * DB_STORAGE_USD_PER_GB_MONTH +
  p.publishedApps * PUBLISHED_APP_GB * PUBLISHED_STORAGE_USD_PER_GB_MONTH +
  p.bandwidthGb * EGRESS_USD_PER_GB

/** Worst-case monthly cost of a plan: every credit spent, on top of everything standing. */
export const planCogsUsd = (p: PlanSpec) => p.credits * CREDIT_USD + planStandingUsd(p)

/** Monthly revenue at the *yearly* price, which is the lower of the two and therefore the one to test against. */
export const planRevenueUsd = (p: PlanSpec) => (p.yearlyPrice || p.price) * (1 - PAYMENT_FEE_RATE)

/**
 * Gross margin on a plan whose user burns every credit they were given.
 * `null` for free plans, where there is no revenue to take a ratio of.
 */
export function planMargin(p: PlanSpec): number | null {
  const revenue = planRevenueUsd(p)
  if (revenue <= 0) return null
  return (revenue - planCogsUsd(p)) / revenue
}

/** Why a plan fails its budget, or null when it clears. Used by the test that guards the plan table. */
export function planBudgetError(p: PlanSpec): string | null {
  const cogs = planCogsUsd(p)
  const revenue = planRevenueUsd(p)
  if (revenue <= 0)
    return cogs <= FREE_COGS_CEILING_USD
      ? null
      : `${p.id}: ${p.credits} credits cost $${cogs.toFixed(2)} a month, over the $${FREE_COGS_CEILING_USD} free ceiling`
  const allowed = revenue * MAX_COGS_RATIO
  return cogs <= allowed
    ? null
    : `${p.id}: ${p.credits} credits cost $${cogs.toFixed(2)} against $${revenue.toFixed(2)} of revenue — ` +
      `over the ${Math.round(MAX_COGS_RATIO * 100)}% ceiling of $${allowed.toFixed(2)}`
}

/**
 * The largest credit allowance a plan could carry and still clear its budget, once its standing
 * costs are paid. Negative means the plan cannot afford what it already gives away for free.
 */
export function maxCreditsFor(p: PlanSpec): number {
  const revenue = planRevenueUsd(p)
  const budget = revenue <= 0 ? FREE_COGS_CEILING_USD : revenue * MAX_COGS_RATIO
  return Math.floor((budget - planStandingUsd(p)) / CREDIT_USD)
}

/**
 * How much of one charge comes out of the wallet.
 *
 * The plan's allowance is spent first and the wallet covers the overflow, so the wallet pays for
 * the part of this period's spend that runs past the allowance — and never more than the charge
 * being made, or a top-up would retroactively pay for turns that happened before it was bought.
 *
 * `usedAfter` is the period's spend *including* this charge. CreditsService mirrors this
 * expression in SQL so the read and the write happen in one statement; this is its definition.
 */
export const walletSpend = (usedAfter: number, included: number, charge: number) =>
  Math.max(0, Math.min(charge, usedAfter - included))

// ── Top-ups ──
//
// A pack has no standing cost — it buys credits, not storage or published apps — so its budget is
// the same question with one term: what the credits can cost, against what the pack earns.

export const packCogsUsd = (p: CreditPack) => p.credits * CREDIT_USD
export const packRevenueUsd = (p: CreditPack) => p.price * (1 - PAYMENT_FEE_RATE)

/** Gross margin on a pack whose every credit is burned. */
export const packMargin = (p: CreditPack) => (packRevenueUsd(p) - packCogsUsd(p)) / packRevenueUsd(p)

/** Why a pack fails its budget, or null when it clears. Guarded by the same test as the plans. */
export function packBudgetError(p: CreditPack): string | null {
  const cogs = packCogsUsd(p)
  const revenue = packRevenueUsd(p)
  const allowed = revenue * MAX_COGS_RATIO
  return cogs <= allowed
    ? null
    : `pack ${p.id}: ${p.credits} credits cost $${cogs.toFixed(2)} against $${revenue.toFixed(2)} of revenue — ` +
      `over the ${Math.round(MAX_COGS_RATIO * 100)}% ceiling of $${allowed.toFixed(2)}`
}

/** The most credits a pack could carry at its price and still clear its budget. */
export const maxPackCreditsFor = (p: CreditPack) => Math.floor((packRevenueUsd(p) * MAX_COGS_RATIO) / CREDIT_USD)

export const packReport = () =>
  CREDIT_PACKS.map((p) => ({
    pack: p.id,
    credits: p.credits,
    usdPerCredit: +(p.price / p.credits).toFixed(4),
    headroom: maxPackCreditsFor(p) - p.credits,
    cogsUsd: +packCogsUsd(p).toFixed(2),
    revenueUsd: +packRevenueUsd(p).toFixed(2),
    margin: +(packMargin(p) * 100).toFixed(1),
    error: packBudgetError(p),
  }))

export const budgetReport = () =>
  (Object.keys(PLANS) as Plan[]).map((id) => {
    const p = PLANS[id]
    const margin = planMargin(p)
    return {
      plan: id,
      credits: p.credits,
      headroom: maxCreditsFor(p) - p.credits,
      standingUsd: +planStandingUsd(p).toFixed(2),
      cogsUsd: +planCogsUsd(p).toFixed(2),
      revenueUsd: +planRevenueUsd(p).toFixed(2),
      margin: margin === null ? null : +(margin * 100).toFixed(1),
      error: planBudgetError(p),
    }
  })
