import { createServerFn } from '@tanstack/react-start'
import { packOf, type Plan } from '@lovbase/core/plans'
import {
  BillingService, ConfigService, CreditsService, CryptoService, InterestService, LlmService, UserSettingsService, svc,
} from '@lovbase/api'
import { currentUser, requireAdmin, requireUser } from './_ctx'

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
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('The baseURL has to start with http(s)://')
    if (!d.model.trim()) throw new Error('The model name cannot be empty')
    return { baseUrl, apiKey: d.apiKey.trim(), model: d.model.trim() }
  })
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    if (!(await (await svc(LlmService)).canByok(user.id))) throw new Error('LIMIT:Bringing your own model is a feature of the Pro plan and above')
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

/** Balance, recent usage and what went into the wallet — everything the account page shows. */
export const myCredits = createServerFn().handler(async () => {
  const { user } = await requireUser()
  const credits = await svc(CreditsService)
  const [balance, rows, grants] = await Promise.all([
    credits.balanceOf(user.id), credits.usageOf(user.id, 30), credits.grantsOf(user.id, 5),
  ])
  return { balance, rows, grants, billing: (await svc(BillingService)).enabled }
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
      await recordIntent(user.id, { kind: 'plan', target: data.plan, source: 'checkout' })
      return { url: null as string | null }
    }
    return { url: await billing.checkoutUrl(user, data.plan, !!data.yearly, data.origin) }
  })

/**
 * Buys a credit pack. Same shape as `startCheckout`: with no Stripe keys configured the call
 * returns `{ url: null }` and the click is recorded as intent, so the button is worth having
 * before payments are switched on.
 */
export const buyCredits = createServerFn({ method: 'POST' })
  .validator((d: { pack: string; origin: string }) => {
    if (!packOf(d.pack)) throw new Error('No such credit pack')
    return d
  })
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    const billing = await svc(BillingService)
    if (!billing.enabled) {
      await recordIntent(user.id, { kind: 'pack', target: data.pack, source: 'checkout' })
      return { url: null as string | null }
    }
    return { url: await billing.creditCheckoutUrl(user, data.pack, data.origin) }
  })

/** Stripe customer portal for an existing subscriber. */
export const billingPortal = createServerFn({ method: 'POST' })
  .validator((d: { origin: string }) => d)
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    return { url: await (await svc(BillingService)).portalUrl(user.id, data.origin) }
  })

/** Records that a user asked to upgrade. `source` says which door they pushed on. */
export const requestUpgrade = createServerFn({ method: 'POST' })
  .validator((d?: { kind?: string; source?: string; target?: string }) => d ?? {})
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    await recordIntent(user.id, {
      kind: data.kind === 'pack' ? 'pack' : 'plan', target: data.target ?? '', source: data.source ?? 'upgrade',
    })
    return { ok: true }
  })

/**
 * A click on something that costs money, while nothing here can take money.
 *
 * It used to be appended to the activity log of the user's first project, which made it both
 * unreadable — you had to go project by project — and incomplete: `if (existing[0])` silently
 * dropped the click of anyone who had not made a project yet, which is the one person whose
 * interest is least explained by anything else.
 */
async function recordIntent(userId: string, i: { kind: string; target?: string; source: string }) {
  await (await svc(InterestService)).record(userId, i)
}

/**
 * Who is looking at a public page. The marketing pages render for everyone, so they may not
 * require a session; but a signed-in person who lands on /pricing should be offered the plan,
 * not the signup form they have already been through.
 */
export const viewer = createServerFn().handler(async () => {
  const me = await currentUser()
  return me ? { signedIn: true as const, plan: me.plan as string } : { signedIn: false as const, plan: null }
})

/** What the sign-in page may offer. Public: it is read before anyone has signed in. */
export const authOptions = createServerFn().handler(async () => (await svc(ConfigService)).authOptions)
