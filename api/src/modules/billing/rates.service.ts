import { Injectable } from '@nestjs/common'
import {
  DEFAULT_MODEL_RATES, TIER_MARGIN, containerCostUsd, creditsForContainer, creditsForTokens,
  rateFor, tokenCostUsd, type ModelRate, type Tier, type Usage,
} from '@lovbase/core/billing'
import { SettingsService } from '../accounts/settings.service'

const RATES_KEY = 'billing.rates'

/** What an admin can change without a deploy. Stored whole so one save is one consistent table. */
export type RatesConfig = {
  /** model id → tier + list price per 1M tokens. Replaces the built-in table entirely. */
  models: Record<string, ModelRate>
  /** Markup per tier. Omitted tiers keep the built-in value. */
  margin?: Partial<Record<Tier, number>>
}

/** A rate frozen for the length of one turn. */
export type Pricer = {
  tier: Tier
  charge: (usage: Usage, byok: boolean) => Charge
}

export type Charge = {
  credits: number
  /** Provider cost before markup, for the ledger. Zero for BYOK. */
  costUsd: number
  tier: Tier
}

/**
 * Turns measured usage into credits, using a table the admin owns.
 *
 * Which model sits in which tier is a pricing decision, not a constant, so it lives in settings and
 * the code only supplies a starting point. An unconfigured model falls back to the most expensive
 * tier — see `FALLBACK_RATE` for why guessing cheap is the dangerous direction.
 */
@Injectable()
export class RatesService {
  private cache: { at: number; value: RatesConfig } | null = null

  constructor(private readonly settings: SettingsService) {}

  /** Cached briefly: this is read on every turn, and an admin edit landing a minute late is fine. */
  async config(): Promise<RatesConfig> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.value
    const stored = await this.settings.get<RatesConfig>(RATES_KEY)
    const value: RatesConfig = { models: stored?.models ?? DEFAULT_MODEL_RATES, margin: stored?.margin }
    this.cache = { at: Date.now(), value }
    return value
  }

  async save(config: RatesConfig) {
    await this.settings.set(RATES_KEY, config)
    this.cache = null
  }

  async reset() {
    await this.settings.delete(RATES_KEY)
    this.cache = null
  }

  private async rate(model: string): Promise<ModelRate> {
    return rateFor(model, (await this.config()).models)
  }

  private async margin(tier: Tier): Promise<number> {
    return (await this.config()).margin?.[tier] ?? TIER_MARGIN[tier]
  }

  /**
   * The rate for one turn, resolved once.
   *
   * A turn quotes its own cost to the user as it finishes and is charged for it a moment later; if
   * each of those re-read the table, an admin saving a new price in between would make the two
   * numbers disagree. Resolving once and pricing twice off the result is what keeps them equal.
   *
   * `served` is the tier the request actually ran on. It decides the markup even when the model
   * itself is not in the rate table, which is the normal case right after an admin points a tier
   * at a newly released model.
   */
  async pricerFor(model: string, served?: Tier): Promise<Pricer> {
    const base = await this.rate(model)
    const rate: ModelRate = served ? { ...base, tier: served } : base
    const margin = await this.margin(rate.tier)
    return {
      tier: rate.tier,
      // BYOK costs the user nothing here — they already paid the provider.
      charge: (usage, byok) => byok
        ? { credits: 0, costUsd: 0, tier: rate.tier }
        : { credits: creditsForTokens(usage, rate, { margin }), costUsd: tokenCostUsd(usage, rate), tier: rate.tier },
    }
  }

  /** Model usage, priced in one call. */
  async forTokens(model: string, usage: Usage, byok: boolean, served?: Tier): Promise<Charge> {
    return (await this.pricerFor(model, served)).charge(usage, byok)
  }

  /** Container time. Charged to BYOK users too: the hardware is ours either way. */
  async forContainer(ms: number): Promise<Charge> {
    const tier: Tier = 'standard'
    return {
      credits: creditsForContainer(ms / 1000, tier, await this.margin(tier)),
      costUsd: containerCostUsd(ms / 1000),
      tier,
    }
  }
}
