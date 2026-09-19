import { createServerFn } from '@tanstack/react-start'
import type { Plan } from '@lovbase/core/plans'
import {
  AccountsService, CreditsService, CryptoService, LlmService, SettingsService, svc, type PlatformLlm,
} from '@lovbase/api'
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
      baseUrl: llm?.baseUrl ?? '', model: llm?.model ?? '', hasKey: !!llm?.apiKeyEnc,
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

/** Admin: grant (or claw back) credits for the user's current period. */
export const adminGrantCredits = createServerFn({ method: 'POST' })
  .validator((d: { userId: string; amount: number }) => d)
  .handler(async ({ data }) => {
    await requireAdmin()
    await (await svc(CreditsService)).grant(data.userId, data.amount)
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
  .validator((d: { baseUrl: string; apiKey: string; model: string }) => {
    const baseUrl = d.baseUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('baseURL 需要以 http(s):// 开头')
    if (!d.model.trim()) throw new Error('模型名不能为空')
    return { baseUrl, apiKey: d.apiKey.trim(), model: d.model.trim() }
  })
  .handler(async ({ data }) => {
    await requireAdmin()
    const settings = await svc(SettingsService)
    const prev = await settings.get<PlatformLlm>('llm')
    const apiKeyEnc = data.apiKey ? await (await svc(CryptoService)).encrypt(data.apiKey) : prev?.apiKeyEnc ?? null
    await settings.set('llm', { baseUrl: data.baseUrl, apiKeyEnc, model: data.model } satisfies PlatformLlm)
    return { ok: true }
  })

export const adminClearLlm = createServerFn({ method: 'POST' }).handler(async () => {
  await requireAdmin()
  await (await svc(SettingsService)).delete('llm')
  return { ok: true }
})
