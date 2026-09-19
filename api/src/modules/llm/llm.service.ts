import { Injectable } from '@nestjs/common'
import OpenAI from 'openai'
import { planOf } from '@lovbase/core/plans'
import { TIERS, TIER_LABEL, type Tier } from '@lovbase/core/billing'
import { ConfigService } from '../../config/config.service'
import { CryptoService } from '../crypto/crypto.service'
import { AccountsService } from '../accounts/accounts.service'
import { SettingsService } from '../accounts/settings.service'
import { UserSettingsService } from '../accounts/user-settings.service'

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
 * constantly, and an admin has to be able to swap what sits behind "标准" without touching pricing
 * copy, the plan table, or anybody's saved preference.
 *
 * `model` without `tiers` is the original single-model shape and is still read — it becomes the
 * default tier, so an existing configuration keeps working untouched.
 */
export type PlatformLlm = {
  baseUrl: string
  apiKeyEnc: string | null
  model?: string
  tiers?: Partial<Record<Tier, TierLlm>>
  defaultTier?: Tier
}

/** What the composer shows: the tiers an admin has actually filled in. */
export type TierOption = { tier: Tier; label: { zh: string; en: string }; model: string; isDefault: boolean }

/**
 * One completion against an OpenAI-compatible endpoint. Free of the DI container on purpose:
 * the eval harness drives the same code path without a database behind it.
 */
export async function chatCompletion(cfg: LlmConfig, system: string, user: string): Promise<string> {
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey })
  const res = await client.chat.completions.create({
    model: cfg.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  })
  const text = res.choices?.[0]?.message?.content
  if (!text)
    throw new Error(`网关响应里没有内容(${JSON.stringify(res).slice(0, 200)})— 检查 baseURL 是否以 /v1 结尾、模型名是否正确`)
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
    return TIERS.filter((t) => st.tiers[t]).map((t) => ({
      tier: t, label: TIER_LABEL[t], model: st.tiers[t]!.model, isDefault: t === st.def,
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
    return !c ? '' : c.source === 'user' ? `${c.model} · 自带 key` : c.model
  }

  /** One-shot completion. The streaming agent builds its own client from the same config. */
  chat(cfg: LlmConfig, system: string, user: string): Promise<string> {
    return chatCompletion(cfg, system, user)
  }
}
