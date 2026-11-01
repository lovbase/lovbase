import { ModelMeterService, type ModelContext } from '../billing/model-meter.service'
import { RatesService } from '../billing/rates.service'
import { priceKey, publicPrices, type PublicPrice } from './public-prices'
import { Injectable } from '@nestjs/common'
import OpenAI from 'openai'
import { planOf } from '@lovbase/core/plans'
import { TIERS, TIER_LABEL, type Tier } from '@lovbase/core/billing'
import { ConfigService } from '../../config/config.service'
import { CryptoService } from '../crypto/crypto.service'
import { AccountsService } from '../accounts/accounts.service'
import { SettingsService } from '../accounts/settings.service'
import { UserSettingsService } from '../accounts/user-settings.service'
import { mcpFetch } from '../integrations/mcp-network'

// One client for every provider: plain OpenAI protocol, no structured-output modes — those are
// the least-supported part of compatible gateways.
// Resolution order: the user's own key (BYOK, stored encrypted, paid plans only) → the
// admin-configured platform model → environment variables.

export type LlmConfig = {
  baseURL: string; apiKey: string; model: string
  source: 'user' | 'platform'
  /** Which tier served this request; the meter prices by it. Absent for BYOK. */
  tier?: Tier
}

/** One tier's model. `baseUrl`/`apiKeyEnc` are optional overrides on the shared provider. */
export type TierLlm = { model: string; baseUrl?: string; apiKeyEnc?: string | null }

/**
 * The platform's models, as an admin configures them.
 *
 * Users pick a *tier*, never a model id. That indirection is the point: provider model names churn
 * constantly, and an admin has to be able to swap what sits behind "standard" without touching pricing
 * copy, the plan table, or anybody's saved preference.
 *
 * `model` without `tiers` is the original single-model shape and is still read — it becomes the
 * default tier, so an existing configuration keeps working untouched.
 */
export type PlatformLlm = {
  baseUrl: string
  apiKeyEnc: string | null
  model?: string
  /** The models an admin added from the catalog: what the tier pickers offer. */
  models?: string[]
  tiers?: Partial<Record<Tier, TierLlm>>
  defaultTier?: Tier
}

/** One model in an endpoint's /models, priced in USD per million tokens when the gateway says. */
export type LlmCatalogEntry = {
  id: string; inPer1M?: number; outPer1M?: number; cachedInPer1M?: number
  /** Where the price came from: the endpoint's own list, or a public catalog filling its gap. */
  priceSource?: 'endpoint' | PublicPrice['source']
}
export type LlmPing = { model: string; ok: boolean; ms: number; error?: string }

/**
 * USD per million tokens, when the gateway's /models says. Vercel AI Gateway and OpenRouter both
 * do, as per-token strings, under different keys; a plain OpenAI endpoint does not.
 */
function pricing(m: object): Omit<LlmCatalogEntry, 'id'> {
  const p = (m as { pricing?: Record<string, unknown> }).pricing
  const per1M = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Math.round(Number(v) * 1e6 * 1e4) / 1e4 : undefined)
  const out = p ? { inPer1M: per1M(p.input ?? p.prompt), outPer1M: per1M(p.output ?? p.completion), cachedInPer1M: per1M(p.input_cache_read) } : {}
  return out.inPer1M != null && out.outPer1M != null ? { ...out, priceSource: 'endpoint' } : {}
}

/** Prices for whatever the endpoint left unpriced, from the public catalogs. */
export async function withPublicPrices(list: LlmCatalogEntry[]): Promise<LlmCatalogEntry[]> {
  if (list.every((m) => m.priceSource)) return list
  const index = await publicPrices()
  return list.map((m) => {
    if (m.priceSource) return m
    const p = index.get(priceKey(m.id))
    return p ? { ...m, inPer1M: p.inPer1M, outPer1M: p.outPer1M, cachedInPer1M: p.cachedInPer1M, priceSource: p.source } : m
  })
}

/** What the composer shows: the tiers an admin has actually filled in. */
export type TierOption = {
  tier: Tier; label: { zh: string; en: string }; model: string; isDefault: boolean
  /**
   * Credits this tier spends per token, relative to the default tier, markup included — what the
   * user actually pays, not what the provider charges. Absent when there is only one tier.
   */
  ratio?: number
}

/**
 * One completion against an OpenAI-compatible endpoint. Free of the DI container on purpose:
 * the eval harness drives the same code path without a database behind it.
 */
export async function chatCompletion(cfg: LlmConfig, system: string, user: string, modelFetch?: typeof fetch): Promise<string> {
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, fetch: modelFetch })
  const res = await client.chat.completions.create({
    model: cfg.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  })
  const text = res.choices?.[0]?.message?.content
  if (!text)
    throw new Error(`The gateway response has no content (${JSON.stringify(res).slice(0, 200)}) — check that baseURL ends in /v1 and the model name is right`)
  return text
}

@Injectable()
export class LlmService {
  constructor(
    private readonly cfg: ConfigService,
    private readonly crypto: CryptoService,
    private readonly accounts: AccountsService,
    private readonly settings: SettingsService,
    private readonly userSettings: UserSettingsService,
    private readonly meter: ModelMeterService,
    private readonly rates: RatesService,
  ) {}

  fromEnv(): LlmConfig | null {
    const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, ANTHROPIC_API_KEY } = this.cfg.env
    if (LLM_BASE_URL && LLM_MODEL)
      return { baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY ?? 'none', model: LLM_MODEL, source: 'platform' }
    if (ANTHROPIC_API_KEY)
      return { baseURL: 'https://api.anthropic.com/v1/', apiKey: ANTHROPIC_API_KEY, model: LLM_MODEL ?? 'claude-sonnet-5', source: 'platform' }
    return null
  }

  /** Normalised view of the stored config: the legacy single model reads as one filled tier. */
  private async stored(): Promise<{ cfg: PlatformLlm; tiers: Partial<Record<Tier, TierLlm>>; def: Tier } | null> {
    const cfg = await this.settings.get<PlatformLlm>('llm')
    if (!cfg?.baseUrl) return null
    const tiers = cfg.tiers && Object.keys(cfg.tiers).length
      ? cfg.tiers
      : cfg.model
        ? ({ standard: { model: cfg.model } } as Partial<Record<Tier, TierLlm>>)
        : {}
    if (!Object.keys(tiers).length) return null
    const def = (cfg.defaultTier && tiers[cfg.defaultTier] ? cfg.defaultTier : (TIERS.find((t) => tiers[t]) as Tier))
    return { cfg, tiers, def }
  }

  /** The tiers a user may pick from. Empty when the admin has configured nothing. */
  async tierOptions(): Promise<TierOption[]> {
    const st = await this.stored()
    if (!st) {
      const env = this.fromEnv()
      return env ? [{ tier: 'standard', label: TIER_LABEL.standard, model: env.model, isDefault: true }] : []
    }
    const offered = TIERS.filter((t) => st.tiers[t])
    // A turn reads roughly three tokens for every one it writes, so input dominates the blend.
    const cost = async (t: Tier) => {
      const { rate, margin } = (await this.rates.pricerFor(st.tiers[t]!.model, t)).pricing
      return (rate.inPer1M * 0.75 + rate.outPer1M * 0.25) * margin
    }
    const costs = new Map(await Promise.all(offered.map(async (t) => [t, await cost(t)] as const)))
    const base = costs.get(st.def) ?? 0
    return offered.map((t) => ({
      tier: t, label: TIER_LABEL[t], model: st.tiers[t]!.model, isDefault: t === st.def,
      ratio: offered.length > 1 && base > 0 ? costs.get(t)! / base : undefined,
    }))
  }

  /**
   * Admin-configured platform model wins over environment variables.
   * An unconfigured tier falls back to the default one rather than failing — the same behaviour a
   * user gets when they pick a tier the admin has since removed.
   */
  async platformConfig(tier?: Tier): Promise<LlmConfig | null> {
    const st = await this.stored()
    if (st) {
      const pick = (tier && st.tiers[tier] ? tier : st.def) as Tier
      const t = st.tiers[pick]!
      const enc = t.apiKeyEnc !== undefined ? t.apiKeyEnc : st.cfg.apiKeyEnc
      // An unreadable key falls through to the environment rather than taking the request down.
      const apiKey = enc ? await this.crypto.tryDecrypt(enc) : 'none'
      if (apiKey !== null)
        return { baseURL: t.baseUrl ?? st.cfg.baseUrl, apiKey, model: t.model, source: 'platform', tier: pick }
    }
    return this.fromEnv()
  }

  /** True when the account's plan includes bringing your own model. */
  /** True when the user has a stored key that can no longer be decrypted and must be re-entered. */
  async byokUnreadable(userId: string): Promise<boolean> {
    const s = await this.userSettings.get(userId)
    if (!s?.llm_api_key_enc) return false
    return (await this.crypto.tryDecrypt(s.llm_api_key_enc)) === null
  }

  async canByok(userId: string): Promise<boolean> {
    const acct = await this.accounts.get(userId)
    return planOf(acct?.plan).byok
  }

  async configFor(userId: string, tier?: Tier): Promise<LlmConfig | null> {
    // A downgrade must stop honouring a stored key, so the plan is checked on every call
    // rather than only at save time.
    if (!(await this.canByok(userId))) return this.platformConfig(tier)
    const s = await this.userSettings.get(userId)
    if (s?.llm_base_url && s.llm_model) {
      const apiKey = s.llm_api_key_enc ? await this.crypto.tryDecrypt(s.llm_api_key_enc) : 'none'
      if (apiKey !== null) return { baseURL: s.llm_base_url, apiKey, model: s.llm_model, source: 'user' }
      // Their own key is unreadable; the platform model keeps them working while they re-enter it.
    }
    return this.platformConfig(tier)
  }

  describe(c: LlmConfig | null) {
    return !c ? '' : c.source === 'user' ? `${c.model} · own key` : c.model
  }

  /** The key an admin form means: the one typed, or the saved one when the field is left empty. */
  private async adminKey(apiKey: string, baseURL: string): Promise<string> {
    if (apiKey) return apiKey
    const saved = await this.savedKey(baseURL)
    if (saved.state === 'unreadable') throw new Error('KEY_UNREADABLE')
    return saved.key ?? 'none'
  }

  /**
   * The saved platform key, for an admin form. One that no longer decrypts (the encryption key
   * changed) is replaced by the environment's key when that key is for the same endpoint — the
   * fallback generation already takes — so the form keeps working instead of asking for it again.
   */
  async savedKey(baseURL?: string): Promise<{ state: 'none' | 'ok' | 'env' | 'unreadable'; key?: string; hint?: string }> {
    const enc = (await this.settings.get<PlatformLlm>('llm'))?.apiKeyEnc
    const hint = (k: string) => k.length > 8 ? k.slice(-4) : undefined
    const saved = enc ? await this.crypto.tryDecrypt(enc) : null
    if (saved) return { state: 'ok', key: saved, hint: hint(saved) }
    const env = this.fromEnv()
    const strip = (u: string) => u.replace(/\/+$/, '')
    if (env && env.apiKey !== 'none' && (!baseURL || strip(env.baseURL) === strip(baseURL)))
      return { state: 'env', key: env.apiKey, hint: hint(env.apiKey) }
    return { state: enc ? 'unreadable' : 'none' }
  }

  /** Admin: the endpoint's /models, with prices where the gateway lists them. Also proves the key works. */
  async catalog(baseURL: string, apiKey: string): Promise<LlmCatalogEntry[]> {
    const client = new OpenAI({ baseURL, apiKey: await this.adminKey(apiKey, baseURL), timeout: 30_000, maxRetries: 0 })
    const out: LlmCatalogEntry[] = []
    for await (const m of client.models.list()) out.push({ id: m.id, ...pricing(m) })
    return withPublicPrices(out.sort((a, b) => a.id.localeCompare(b.id)))
  }

  /**
   * A user's own model list (BYOK). Unlike the admin's, the URL is anyone's to type, so the request
   * goes through the same guard as user-added MCP servers: HTTPS, a public address pinned to the
   * socket, no redirects — otherwise "fetch models" would be a way to probe the internal network.
   * An empty key means the one they saved.
   */
  async userCatalog(userId: string, baseURL: string, apiKey: string): Promise<LlmCatalogEntry[]> {
    if (!(await this.canByok(userId))) throw new Error('LIMIT:Bringing your own model is a feature of the Pro plan and above')
    if (!apiKey) {
      const enc = (await this.userSettings.get(userId))?.llm_api_key_enc
      const saved = enc ? await this.crypto.tryDecrypt(enc) : null
      if (enc && saved === null) throw new Error('KEY_UNREADABLE')
      apiKey = saved ?? 'none'
    }
    const client = new OpenAI({ baseURL, apiKey, timeout: 20_000, maxRetries: 0, fetch: mcpFetch(20_000, 8_000_000) as unknown as typeof fetch })
    const out: LlmCatalogEntry[] = []
    try {
      for await (const m of client.models.list()) out.push({ id: m.id, ...pricing(m) })
    } catch (e) {
      // The SDK reports a refused address as a bare "Connection error."; the guard's reason is the cause.
      const cause = (e as { cause?: unknown }).cause
      if (cause instanceof Error && /Local or reserved|must use HTTPS/.test(cause.message)) throw new Error('PUBLIC_ONLY')
      throw e
    }
    return withPublicPrices(out.sort((a, b) => a.id.localeCompare(b.id)))
  }

  /**
   * Admin "Test": send each tier's model one tiny completion, so a mistyped model or one the key
   * cannot reach shows up here rather than in a user's first failed turn. Nothing is metered.
   */
  async ping(baseURL: string, apiKey: string, models: string[]): Promise<LlmPing[]> {
    const client = new OpenAI({ baseURL, apiKey: await this.adminKey(apiKey, baseURL), timeout: 30_000, maxRetries: 0 })
    return Promise.all([...new Set(models)].map(async (model) => {
      const t0 = Date.now()
      try {
        await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with OK.' }] })
        return { model, ok: true, ms: Date.now() - t0 }
      } catch (e) {
        return { model, ok: false, ms: Date.now() - t0, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }
      }
    }))
  }

  /** One-shot completion. The streaming agent builds its own client from the same config. */
  chat(cfg: LlmConfig, system: string, user: string, ctx?: ModelContext): Promise<string> {
    return chatCompletion(cfg, system, user, ctx ? this.meter.fetchFor(cfg, ctx) : undefined)
  }
}
