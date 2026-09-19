import { Injectable } from '@nestjs/common'
import OpenAI from 'openai'
import { planOf } from '@lovbase/core/plans'
import { ConfigService } from '../../config/config.service'
import { CryptoService } from '../crypto/crypto.service'
import { AccountsService } from '../accounts/accounts.service'
import { SettingsService } from '../accounts/settings.service'
import { UserSettingsService } from '../accounts/user-settings.service'

// One client for every provider: plain OpenAI protocol, no structured-output modes — those are
// the least-supported part of compatible gateways.
// Resolution order: the user's own key (BYOK, stored encrypted, paid plans only) → the
// admin-configured platform model → environment variables.

export type LlmConfig = { baseURL: string; apiKey: string; model: string; source: 'user' | 'platform' }
export type PlatformLlm = { baseUrl: string; apiKeyEnc: string | null; model: string }

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

  /** Admin-configured platform model (Admin → 全局模型) wins over environment variables. */
  async platformConfig(): Promise<LlmConfig | null> {
    const stored = await this.settings.get<PlatformLlm>('llm')
    if (stored?.baseUrl && stored.model)
      return {
        baseURL: stored.baseUrl,
        apiKey: stored.apiKeyEnc ? await this.crypto.decrypt(stored.apiKeyEnc) : 'none',
        model: stored.model,
        source: 'platform',
      }
    return this.fromEnv()
  }

  /** True when the account's plan includes bringing your own model. */
  async canByok(userId: string): Promise<boolean> {
    const acct = await this.accounts.get(userId)
    return planOf(acct?.plan).byok
  }

  async configFor(userId: string): Promise<LlmConfig | null> {
    // A downgrade must stop honouring a stored key, so the plan is checked on every call
    // rather than only at save time.
    if (!(await this.canByok(userId))) return this.platformConfig()
    const s = await this.userSettings.get(userId)
    if (s?.llm_base_url && s.llm_model)
      return {
        baseURL: s.llm_base_url,
        apiKey: s.llm_api_key_enc ? await this.crypto.decrypt(s.llm_api_key_enc) : 'none',
        model: s.llm_model,
        source: 'user',
      }
    return this.platformConfig()
  }

  describe(c: LlmConfig | null) {
    return !c ? '' : c.source === 'user' ? `${c.model} · 自带 key` : c.model
  }

  /** One-shot completion. The streaming agent builds its own client from the same config. */
  chat(cfg: LlmConfig, system: string, user: string): Promise<string> {
    return chatCompletion(cfg, system, user)
  }
}
