import { describe, expect, test } from 'bun:test'
import { CREDIT_PACKS, PLANS, packOf, type Plan } from '../src/plans'
import {
  CREDIT_USD, DEFAULT_MODEL_RATES, FALLBACK_RATE, TIER_MARGIN,
  budgetReport, containerCostUsd, creditsForContainer, creditsForTokens,
  maxCreditsFor, maxPackCreditsFor, packBudgetError, packMargin, packReport,
  planBudgetError, planMargin, rateFor, tokenCostUsd, walletSpend,
} from '../src/billing'

const planIds = Object.keys(PLANS) as Plan[]

// ── The guard ──
// This is the test that exists so "will this plan lose money" never has to be remembered. Raise a
// plan's credits past what its price can pay for and CI says so, with the number to use instead.
describe('every plan can afford its own allowance', () => {
  for (const id of planIds) {
    test(`${id}`, () => {
      const error = planBudgetError(PLANS[id])
      const hint = error ? `${error}\n  → credits must be ${maxCreditsFor(PLANS[id])} or fewer` : ''
      expect(hint).toBe('')
    })
  }

  test('paid plans keep a real margin even when every credit is burned', () => {
    for (const id of planIds) {
      const margin = planMargin(PLANS[id])
      if (margin === null) continue // free plan: capped in absolute terms instead
      expect(margin).toBeGreaterThanOrEqual(0.6)
    }
  })

  test('the report names the headroom, so raising a plan is a lookup not a guess', () => {
    for (const row of budgetReport()) {
      expect(row.error).toBeNull()
      expect(row.headroom).toBeGreaterThanOrEqual(0)
    }
  })
})

// The same guard for top-ups: a pack is credits sold at a price, and the price has to cover them.
describe('every credit pack can afford its own credits', () => {
  for (const pack of CREDIT_PACKS) {
    test(`${pack.id}`, () => {
      const error = packBudgetError(pack)
      const hint = error ? `${error}\n  → credits must be ${maxPackCreditsFor(pack)} or fewer` : ''
      expect(hint).toBe('')
      expect(packMargin(pack)).toBeGreaterThanOrEqual(0.6)
    })
  }

  test('buying more is cheaper per credit, or the ladder has no reason to exist', () => {
    const perCredit = CREDIT_PACKS.map((p) => p.price / p.credits)
    for (let i = 1; i < perCredit.length; i++) expect(perCredit[i]).toBeLessThan(perCredit[i - 1])
  })

  test('a pack never undercuts a subscription, or the plans are the worse deal', () => {
    // The best per-credit rate anyone can subscribe to, which is a paid plan billed yearly.
    const bestPlanRate = Math.min(
      ...planIds.map((id) => PLANS[id]).filter((p) => p.price).map((p) => (p.yearlyPrice || p.price) / p.credits))
    for (const pack of CREDIT_PACKS) expect(pack.price / pack.credits).toBeGreaterThanOrEqual(bestPlanRate)
  })

  test('the report names the headroom, and an unknown pack is not a pack', () => {
    for (const row of packReport()) expect(row.error).toBeNull()
    expect(packOf('nope')).toBeNull()
    expect(packOf(CREDIT_PACKS[0].id)?.credits).toBe(CREDIT_PACKS[0].credits)
  })
})

// The order the two pots are spent in. Wrong here and either the allowance is skipped (bought
// credits burn while the free monthly ones sit untouched) or the wallet never empties at all.
describe('the allowance is spent before the wallet', () => {
  const included = 100

  test('a charge inside the allowance never touches the wallet', () => {
    expect(walletSpend(40, included, 40)).toBe(0)
    expect(walletSpend(100, included, 60)).toBe(0)
  })

  test('a charge that straddles the allowance splits', () => {
    // 90 already spent, a 30-credit turn: 10 from the allowance, 20 from the wallet.
    expect(walletSpend(120, included, 30)).toBe(20)
  })

  test('once the allowance is gone the wallet pays the whole charge', () => {
    expect(walletSpend(180, included, 30)).toBe(30)
  })

  test('a top-up never pays for turns that happened before it', () => {
    // 5000 spent this period, then a 3-credit turn: the wallet owes 3, not 4903.
    expect(walletSpend(5003, included, 3)).toBe(3)
  })
})

describe('credits track cost, which is the whole point', () => {
  const rate = DEFAULT_MODEL_RATES['claude-sonnet-5']

  test('a small turn and a large turn do not cost the same', () => {
    const small = creditsForTokens({ inTokens: 800, outTokens: 200 }, rate)
    const large = creditsForTokens({ inTokens: 300_000, outTokens: 8_000 }, rate)
    expect(large).toBeGreaterThan(small * 50)
  })

  test('the charge is the provider cost times the tier markup, in credits', () => {
    const usage = { inTokens: 1_000_000, outTokens: 0 }
    const raw = tokenCostUsd(usage, rate)
    expect(raw).toBeCloseTo(rate.inPer1M, 6)
    expect(creditsForTokens(usage, rate)).toBe(Math.ceil((raw * TIER_MARGIN[rate.tier]) / CREDIT_USD))
  })

  test('a metered-but-tiny turn still costs one credit, never zero', () => {
    expect(creditsForTokens({ inTokens: 1, outTokens: 1 }, rate)).toBe(1)
  })
})

describe('BYOK', () => {
  const rate = DEFAULT_MODEL_RATES['claude-sonnet-5']

  test('costs no credits, because the user already paid the provider', () => {
    expect(creditsForTokens({ inTokens: 500_000, outTokens: 20_000 }, rate, { byok: true })).toBe(0)
  })

  test('does not extend to container time, which is still ours', () => {
    expect(creditsForContainer(180)).toBeGreaterThan(0)
    expect(containerCostUsd(60)).toBeGreaterThan(0)
  })
})

describe('an unconfigured model', () => {
  test('is priced as the most expensive tier, never the cheapest', () => {
    const unknown = rateFor('some-model-nobody-added')
    expect(unknown).toEqual(FALLBACK_RATE)
    const cheapest = Math.min(...Object.values(DEFAULT_MODEL_RATES).map((r) => r.inPer1M))
    expect(unknown.inPer1M).toBeGreaterThan(cheapest)
  })

  test('a configured model uses its own rate', () => {
    expect(rateFor('claude-haiku-4-5-20251001').tier).toBe('fast')
  })

  test('an admin-supplied table overrides the defaults', () => {
    const table = { 'house-model': { tier: 'fast' as const, inPer1M: 0.2, outPer1M: 0.4 } }
    expect(rateFor('house-model', table).inPer1M).toBe(0.2)
    expect(rateFor('claude-opus-5', table)).toEqual(FALLBACK_RATE) // not in the admin's table
  })
})
