import { createServerFn } from '@tanstack/react-start'
import type { Plan } from '@lovbase/core/plans'
import {
  AccountsService, RatesService, CreditsService, CryptoService, InterestService, LlmService, SettingsService, RefundsService, svc,
  type PlatformLlm, type TierLlm,
} from '@lovbase/api'
import { TIERS, type Tier } from '@lovbase/core/billing'
import { requireAdmin } from './_ctx'

type CatalogPrice = { inPer1M: number; outPer1M: number; cachedInPer1M?: number }
import { z } from 'zod'

export const adminRefunds = createServerFn().handler(async () => {
  await requireAdmin()
  return (await svc(RefundsService)).overview()
})

export const adminRetryRefund = createServerFn({ method: 'POST' })
  .validator(z.object({ actionKey: z.string().min(1).max(255), reason: z.string().trim().min(1).max(500), confirmed: z.literal(true) }))
  .handler(async ({ data }) => {
    const { user } = await requireAdmin()
    await (await svc(RefundsService)).retryReviewed(data.actionKey, user.email, data.reason)
    return { ok: true }
  })

export const adminForgiveRefundDebt = createServerFn({ method: 'POST' })
  .validator(z.object({ userId: z.string().min(1), amount: z.number().int().positive(), key: z.string().uuid(), reason: z.string().trim().min(1).max(500), confirmed: z.literal(true) }))
  .handler(async ({ data }) => {
    const { user } = await requireAdmin()
    await (await svc(RefundsService)).forgiveDebt(data.userId, data.amount, data.key, user.email, data.reason)
    return { ok: true }
  })

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
  const models = [...new Set([
    ...Object.values(llm?.tiers ?? {}).map(tier => tier?.model), llm?.model, effective?.model,
  ].filter((model): model is string => !!model))]
  const rates = await svc(RatesService)
  const rateDiagnostics = await Promise.all(models.map(async model => ({ model, ...(await rates.pricerFor(model)).pricing })))
  return {
    user, accounts, stats, top, rateDiagnostics, rateTable: (await rates.config()).models,
    llm: {
      baseUrl: llm?.baseUrl ?? '',
      hasKey: !!llm?.apiKeyEnc,
      key: await llmSvc.savedKey(llm?.baseUrl).then(({ state, hint }) => ({ state, hint })),
      // The legacy single `model` reads as the standard tier so an existing setup shows up here.
      tiers: Object.fromEntries(TIERS.map((t) => [t, llm?.tiers?.[t]?.model ?? (t === 'standard' ? llm?.model ?? '' : '')])) as Record<Tier, string>,
      // Saved before the list existed: the tier models are the list.
      models: llm?.models ?? [...new Set([...Object.values(llm?.tiers ?? {}).map((t) => t?.model), llm?.model].filter((m): m is string => !!m))],
      defaultTier: llm?.defaultTier ?? 'standard',
      effective: llmSvc.describe(effective), fromEnv: !!effective && !llm,
    },
  }
})

/**
 * Who reached for a paid thing while payments are off.
 *
 * Both halves matter and say different things: the roll-up is what the pricing decision is made
 * on, counted in people rather than clicks, and the list is who to go and talk to.
 */
export const adminInterest = createServerFn().handler(async () => {
  await requireAdmin()
  const interest = await svc(InterestService)
  return { summary: await interest.summary(), recent: await interest.recent(100) }
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
    if (!Number.isInteger(d.amount) || d.amount === 0) throw new Error('The amount has to be a non-zero integer')
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
    if (data.userId === me.id && !data.isAdmin) throw new Error('You cannot remove your own admin role')
    await (await svc(AccountsService)).setAdmin(data.userId, data.isAdmin)
    return { ok: true }
  })

export const adminSaveLlm = createServerFn({ method: 'POST' })
  .validator((d: { baseUrl: string; apiKey: string; models: string[]; tiers: Record<string, string>; defaultTier: Tier; prices?: Record<string, CatalogPrice> }) => {
    const baseUrl = d.baseUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('The baseURL has to start with http(s)://')
    const tiers = Object.fromEntries(TIERS.map((t) => [t, (d.tiers[t] ?? '').trim()]).filter(([, m]) => m)) as Record<string, string>
    if (!Object.keys(tiers).length) throw new Error('At least one tier needs a model name')
    const defaultTier = tiers[d.defaultTier] ? d.defaultTier : (TIERS.find((t) => tiers[t]) as Tier)
    // A tier's model is always on the list, so the picker can show it next time.
    const models = [...new Set([...d.models, ...Object.values(tiers)].map((m) => m.trim()).filter(Boolean))].slice(0, 200)
    return { baseUrl, apiKey: d.apiKey.trim(), models, tiers, defaultTier, prices: d.prices ?? {} }
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
    await settings.set('llm', { baseUrl: data.baseUrl, apiKeyEnc, models: data.models, tiers, defaultTier: data.defaultTier } satisfies PlatformLlm)
    // A tier model the catalog priced gets that price in the billing table, so it is not charged at
    // the fallback rate. Models already in the table keep any long-context terms they had.
    const priced = Object.entries(data.tiers).filter(([, m]) => {
      const p = data.prices[m]
      return p && Number.isFinite(p.inPer1M) && Number.isFinite(p.outPer1M)
    })
    if (priced.length) {
      const rates = await svc(RatesService)
      const config = await rates.config()
      const table = { ...config.models }
      for (const [tier, model] of priced) {
        const p = data.prices[model]
        table[model] = { ...table[model], tier: tier as Tier, inPer1M: p.inPer1M, outPer1M: p.outPer1M, cachedInPer1M: p.cachedInPer1M }
      }
      await rates.save({ ...config, models: table })
    }
    return { ok: true }
  })

/**
 * Admin: set or remove one model's list price in the billing table. The price an admin types wins
 * over any catalog: it is the one they checked against an invoice.
 */
export const adminSaveRate = createServerFn({ method: 'POST' })
  .validator(z.object({
    model: z.string().trim().min(1).max(200),
    remove: z.boolean().optional(),
    tier: z.enum(TIERS as [Tier, ...Tier[]]).optional(),
    inPer1M: z.number().min(0).max(10_000).optional(),
    outPer1M: z.number().min(0).max(10_000).optional(),
    cachedInPer1M: z.number().min(0).max(10_000).optional(),
  }))
  .handler(async ({ data }) => {
    await requireAdmin()
    const rates = await svc(RatesService)
    const config = await rates.config()
    const table = { ...config.models }
    if (data.remove) delete table[data.model]
    else {
      if (data.inPer1M == null || data.outPer1M == null) throw new Error('Input and output prices are both needed')
      const prev = table[data.model]
      table[data.model] = { ...prev, tier: data.tier ?? prev?.tier ?? 'standard', inPer1M: data.inPer1M, outPer1M: data.outPer1M, cachedInPer1M: data.cachedInPer1M }
    }
    await rates.save({ ...config, models: table })
    return { ok: true }
  })

const endpoint = {
  baseUrl: z.string().trim().transform((s) => s.replace(/\/+$/, '')).pipe(z.string().regex(/^https?:\/\//, 'The baseURL has to start with http(s)://')),
  /** Empty means the saved key. */
  apiKey: z.string().trim().max(500),
}

/** Admin: fetch the endpoint's model list with the key in the form, before anything is saved. */
export const adminListModels = createServerFn({ method: 'POST' })
  .validator(z.object(endpoint))
  .handler(async ({ data }) => {
    await requireAdmin()
    return (await svc(LlmService)).catalog(data.baseUrl, data.apiKey)
  })

/** Admin: one tiny completion per tier model, with the endpoint and key in the form. */
export const adminTestLlm = createServerFn({ method: 'POST' })
  .validator(z.object({ ...endpoint, models: z.array(z.string().trim().min(1).max(200)).min(1).max(TIERS.length) }))
  .handler(async ({ data }) => {
    await requireAdmin()
    return (await svc(LlmService)).ping(data.baseUrl, data.apiKey, data.models)
  })

export const adminClearLlm =createServerFn({ method: 'POST' }).handler(async () => {
  await requireAdmin()
  await (await svc(SettingsService)).delete('llm')
  return { ok: true }
})
