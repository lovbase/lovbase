import { describe, expect, test } from 'bun:test'
import { CREDIT_PACKS, PLANS, packOf, type Plan } from '../src/plans'
import {
  CREDIT_USD, DEFAULT_MODEL_RATES, FALLBACK_RATE, TIER_MARGIN, creditPeriod, effectivePlan,
  budgetReport, containerCostUsd, creditsForContainer, creditsForTokens,
  maxCreditsFor, maxPackCreditsFor, packBudgetError, packMargin, packReport,
  planBudgetError, planMargin, rateFor, tokenCostUsd, walletSpend,
} from '../src/billing'

const planIds = Object.keys(PLANS) as Plan[]

describe('monthly credit periods stay anchored through short months', () => {
  test('Jan 31 clamps to February and returns to March 31 without drift', () => {
    const anchor = '2026-01-31T10:15:30Z'
    const feb = creditPeriod(anchor, new Date('2026-03-15T00:00:00Z'))
    expect(feb.start.toISOString()).toBe('2026-02-28T10:15:30.000Z')
    expect(feb.end.toISOString()).toBe('2026-03-31T10:15:30.000Z')
    expect(creditPeriod(anchor, new Date('2026-03-31T10:15:30Z')).start.toISOString()).toBe('2026-03-31T10:15:30.000Z')
  })
  test('yearly subscribers still get monthly windows, including leap days', () => {
    const p = creditPeriod('2028-01-31T00:00:00Z', new Date('2028-02-29T00:00:00Z'))
    expect(p.start.toISOString()).toBe('2028-02-29T00:00:00.000Z')
    expect(p.end.toISOString()).toBe('2028-03-31T00:00:00.000Z')
  })
  test('expired Stripe rights downgrade while manually assigned plans stay intact', () => {
    const now = new Date('2026-10-22T00:00:00Z')
    expect(effectivePlan({ plan: 'pro', stripe_subscription_id: 'sub_x', stripe_paid_until: now }, now)).toBe('free')
    expect(effectivePlan({ plan: 'business' }, now)).toBe('business')
  })
})

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

describe('GPT Standard API pricing', () => {
  test('the deployed models charge reported cache hits at their own rates', () => {
    for (const [model, expected] of [
      ['gpt-6-luna', 0.008], ['gpt-6.1-sol', 0.14], ['gpt-6-astra', 0.8],
    ] as const) {
      const rate = rateFor(model)
      expect(rate).not.toBe(FALLBACK_RATE)
      // 10k uncached input + 200k cached input + 10k output, all within short context.
      expect(tokenCostUsd({ inTokens: 210_000, cachedTokens: 200_000, outTokens: 10_000 }, rate)).toBeCloseTo(expected, 8)
    }
  })

  test('missing cache usage gets no discount, and cache hits cannot exceed input', () => {
    const rate = rateFor('gpt-6-astra')
    expect(tokenCostUsd({ inTokens: 100_000, outTokens: 0 }, rate)).toBe(1)
    expect(tokenCostUsd({ inTokens: 100_000, cachedTokens: 200_000, outTokens: 0 }, rate)).toBe(0.1)
  })

  test('long context reprices all input, cached input and output only above 272k', () => {
    const rate = rateFor('gpt-6.1-sol')
    expect(tokenCostUsd({ inTokens: 272_000, cachedTokens: 200_000, outTokens: 1000 }, rate)).toBeCloseTo(0.174, 8)
    expect(tokenCostUsd({ inTokens: 272_001, cachedTokens: 200_000, outTokens: 1000 }, rate)).toBeCloseTo(0.343004, 8)
  })

  test('the reported game-edit turn costs 403 credits including its container', () => {
    // Anonymized measured requests from the 2026-10-30 mobile game edit. Price each request
    // individually: rounding an aggregate hides the debit that the customer actually receives.
    const requests = [
      [44801,115,0], [51411,870,44800], [3647,68,0], [3811,78,3584],
      [4303,116,3712], [9492,182,4224], [24888,331,9472], [31846,111,24704],
      [34261,3145,31744], [37408,1074,34176], [41470,1762,37248], [43422,246,41344],
      [43844,1011,43264], [45737,173,43648], [46656,184,45568], [46811,780,46464],
      [48080,68,46720], [48276,71,48000], [48372,80,48256], [48530,624,48256],
    ].map(([inTokens, outTokens, cachedTokens]) => ({ inTokens, outTokens, cachedTokens }))
    const rate = rateFor('gpt-6-astra')
    const container = creditsForContainer(400.866)
    const previous = requests.reduce((n, u) => n + creditsForTokens(u, FALLBACK_RATE), container)
    const corrected = requests.reduce((n, u) => n + creditsForTokens(u, rate), container)
    expect(previous).toBe(2070)
    expect(corrected).toBe(403)
    expect(requests.reduce((n, u) => n + tokenCostUsd(u, rate), 0)).toBeCloseTo(2.178454, 8)
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
