import { createServerFn } from '@tanstack/react-start'
import type { Plan } from '@lovbase/core/plans'
import {
  AccountsService, CreditsService, CryptoService, LlmService, SettingsService, svc,
  type PlatformLlm, type TierLlm,
} from '@lovbase/api'
import { TIERS, type Tier } from '@lovbase/core/billing'
import { requireAdmin } from './_ctx'

export const adminOverview = createServerFn().handler(async () => {
  const { user } = await requireAdmin()
  const llmSvc = await svc(LlmService)
  const credits = await svc(CreditsService)
  const [accounts, llm, effective, stats, top] = await Promise.all([
    svc(AccountsService).then((s) => s.list()),
    svc(SettingsService).then((s) => s.get<PlatformLlm>('llm')),
    llmSvc.platformConfig(),
    credits.platformStats(),
    credits.topConsumers(30, 50),
  ])
  return {
    user, accounts, stats, top,
    llm: {
      baseUrl: llm?.baseUrl ?? '',
      hasKey: !!llm?.apiKeyEnc,
      // The legacy single `model` reads as the standard tier so an existing setup shows up here.
      tiers: Object.fromEntries(TIERS.map((t) => [t, llm?.tiers?.[t]?.model ?? (t === 'standard' ? llm?.model ?? '' : '')])) as Record<Tier, string>,
      defaultTier: llm?.defaultTier ?? 'standard',
      effective: llmSvc.describe(effective), fromEnv: !!effective && !llm,
    },
  }
})

export const adminSetPlan = createServerFn({ method: 'POST' })
  .validator((d: { userId: string; plan: Plan }) => d)
  .handler(async ({ data }) => {
    await requireAdmin()
    await (await svc(CreditsService)).setPlan(data.userId, data.plan, { resetPeriod: true })
    return { ok: true }
  })

/**
 * Admin: put credits in a user's wallet, or take them back with a negative amount. Wallet credits
 * outlive the billing period — see CreditsService — so this is a grant, not a bump to this month.
 */
export const adminGrantCredits = createServerFn({ method: 'POST' })
  .validator((d: { userId: string; amount: number; note?: string }) => {
    if (!Number.isInteger(d.amount) || d.amount === 0) throw new Error('额度要是一个不为零的整数')
    return d
  })
  .handler(async ({ data }) => {
    const { user: me } = await requireAdmin()
    // Who did it is the half of a grant that a ledger row cannot reconstruct later.
    await (await svc(CreditsService)).grant(data.userId, data.amount, {
      source: 'admin', note: `${(data.note ?? '').slice(0, 160)} · ${me.email}`.trim(),
    })
    return { ok: true }
  })

export const adminSetAdmin = createServerFn({ method: 'POST' })
  .validator((d: { userId: string; isAdmin: boolean }) => d)
  .handler(async ({ data }) => {
    const { user: me } = await requireAdmin()
    if (data.userId === me.id && !data.isAdmin) throw new Error('不能取消自己的管理员')
    await (await svc(AccountsService)).setAdmin(data.userId, data.isAdmin)
    return { ok: true }
  })

export const adminSaveLlm = createServerFn({ method: 'POST' })
  .validator((d: { baseUrl: string; apiKey: string; tiers: Record<string, string>; defaultTier: Tier }) => {
    const baseUrl = d.baseUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('baseURL 需要以 http(s):// 开头')
    const tiers = Object.fromEntries(TIERS.map((t) => [t, (d.tiers[t] ?? '').trim()]).filter(([, m]) => m)) as Record<string, string>
    if (!Object.keys(tiers).length) throw new Error('至少要给一个档位填模型名')
    const defaultTier = tiers[d.defaultTier] ? d.defaultTier : (TIERS.find((t) => tiers[t]) as Tier)
    return { baseUrl, apiKey: d.apiKey.trim(), tiers, defaultTier }
  })
  .handler(async ({ data }) => {
    await requireAdmin()
    const settings = await svc(SettingsService)
    const prev = await settings.get<PlatformLlm>('llm')
    const apiKeyEnc = data.apiKey ? await (await svc(CryptoService)).encrypt(data.apiKey) : prev?.apiKeyEnc ?? null
    const tiers = Object.fromEntries(
      Object.entries(data.tiers).map(([t, model]) => [t, { model } satisfies TierLlm]),
    ) as PlatformLlm['tiers']
    // `model` is dropped: writing the tier map is what retires the legacy single-model shape.
    await settings.set('llm', { baseUrl: data.baseUrl, apiKeyEnc, tiers, defaultTier: data.defaultTier } satisfies PlatformLlm)
    return { ok: true }
  })

export const adminClearLlm = createServerFn({ method: 'POST' }).handler(async () => {
  await requireAdmin()
  await (await svc(SettingsService)).delete('llm')
  return { ok: true }
})
