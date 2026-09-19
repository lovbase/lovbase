import { createServerFn } from '@tanstack/react-start'
import type { Plan } from '@lovbase/core/plans'
import {
  BillingService, CreditsService, CryptoService, LlmService, ProjectsService, UserSettingsService, svc,
} from '@lovbase/api'
import { requireAdmin, requireUser } from './_ctx'

// ── Settings (BYOK) ──

export const getSettings = createServerFn().handler(async () => {
  const { user } = await requireUser()
  const llm = await svc(LlmService)
  const s = await (await svc(UserSettingsService)).get(user.id)
  const cfg = await llm.configFor(user.id)
  return {
    user,
    canByok: await llm.canByok(user.id),
    // A stored key encrypted under a previous BETTER_AUTH_SECRET can never be read again; say so
    // instead of letting it look like the key is working.
    keyUnreadable: await llm.byokUnreadable(user.id),
    baseUrl: s?.llm_base_url ?? '',
    model: s?.llm_model ?? '',
    hasKey: !!s?.llm_api_key_enc,
    effective: llm.describe(cfg),
    platformAvailable: cfg?.source === 'platform' || (!!cfg && !s),
  }
})

export const saveSettings = createServerFn({ method: 'POST' })
  .validator((d: { baseUrl: string; apiKey: string; model: string }) => {
    const baseUrl = d.baseUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('baseURL 需要以 http(s):// 开头')
    if (!d.model.trim()) throw new Error('模型名不能为空')
    return { baseUrl, apiKey: d.apiKey.trim(), model: d.model.trim() }
  })
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    if (!(await (await svc(LlmService)).canByok(user.id))) throw new Error('LIMIT:自带模型是 Pro 及以上套餐的功能')
    const settings = await svc(UserSettingsService)
    const prev = await settings.get(user.id)
    // Empty key field on save = keep the stored key.
    const enc = data.apiKey ? await (await svc(CryptoService)).encrypt(data.apiKey) : prev?.llm_api_key_enc ?? null
    await settings.save(user.id, { llm_base_url: data.baseUrl, llm_api_key_enc: enc, llm_model: data.model })
    return { ok: true }
  })

export const clearSettings = createServerFn({ method: 'POST' }).handler(async () => {
  const { user } = await requireUser()
  await (await svc(UserSettingsService)).clear(user.id)
  return { ok: true }
})

// ── Credits and billing ──

/** Balance + recent usage for the account page. */
export const myCredits = createServerFn().handler(async () => {
  const { user } = await requireUser()
  const credits = await svc(CreditsService)
  const [balance, rows] = await Promise.all([credits.balanceOf(user.id), credits.usageOf(user.id, 30)])
  return { balance, rows, billing: (await svc(BillingService)).enabled }
})

/** One user's credit history, for the admin drawer and the account page. */
export const usageDetail = createServerFn({ method: 'POST' })
  .validator((d: { userId?: string; days?: number }) => d)
  .handler(async ({ data }) => {
    const { user: me } = await requireUser()
    const target = data.userId && data.userId !== me.id ? (await requireAdmin(), data.userId) : me.id
    const credits = await svc(CreditsService)
    const [rows, balance] = await Promise.all([credits.usageOf(target, data.days ?? 30), credits.balanceOf(target)])
    return { rows, balance }
  })

/**
 * Starts a Stripe Checkout session. With no Stripe keys configured the call returns
 * `{ url: null }` and the click is recorded as upgrade intent instead.
 */
export const startCheckout = createServerFn({ method: 'POST' })
  .validator((d: { plan: Plan; yearly?: boolean; origin: string }) => d)
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    const billing = await svc(BillingService)
    if (!billing.enabled) {
      await recordIntent(user.id, { event: 'upgrade_click', plan: data.plan, email: user.email })
      return { url: null as string | null }
    }
    return { url: await billing.checkoutUrl(user, data.plan, !!data.yearly, data.origin) }
  })

/** Stripe customer portal for an existing subscriber. */
export const billingPortal = createServerFn({ method: 'POST' })
  .validator((d: { origin: string }) => d)
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    return { url: await (await svc(BillingService)).portalUrl(user.id, data.origin) }
  })

/** Records that a user asked to upgrade. Read this table before deciding pricing. */
export const requestUpgrade = createServerFn({ method: 'POST' }).handler(async () => {
  const { user } = await requireUser()
  await recordIntent(user.id, { event: 'upgrade_click', email: user.email })
  return { ok: true }
})

/** Paywall signals ride along on the user's first project, which is where the log lives. */
async function recordIntent(userId: string, content: Record<string, unknown>) {
  const projects = await svc(ProjectsService)
  const existing = await projects.listFor(userId)
  if (existing[0]) await projects.log(existing[0].id, 'paywall', content)
}
