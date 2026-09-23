import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { AvatarPicker } from '../components/AvatarPicker'
import { billingPortal, buyCredits, clearSettings, getProjects, getSettings, myCredits, saveSettings, startCheckout } from '../functions'
import { CREDIT_PACKS, PLANS, planOf } from '@lovbase/core/plans'
import { useT } from '../lib/i18n'
import { Link } from '@tanstack/react-router'
import { Sidebar } from '../components/Sidebar'
import { ThemeChoice } from '../components/ThemeChoice'
import { LocaleToggle } from '../components/LocaleToggle'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRouter } from '@tanstack/react-router'
import { useDialogs } from '../components/Dialogs'

export const Route = createFileRoute('/settings')({
  loader: async () => ({ ...(await getProjects()), ...(await myCredits()), llm: await getSettings() }),
  component: Account,
  head: () => ({ meta: [{ title: 'Account · Lovbase' }] }),
})

function Account() {
  const t = useT()
  const dialogs = useDialogs()
  const d = Route.useLoaderData()
  const checkout = useServerFn(startCheckout)
  const portal = useServerFn(billingPortal)
  const buy = useServerFn(buyCredits)
  const [asked, setAsked] = useState(false)
  const [wanted, setWanted] = useState(false)
  const [busy, setBusy] = useState(false)
  const spec = planOf(d.user.plan)
  const paid = d.user.plan !== 'free'
  const b = d.balance
  // The bar is the *allowance*, which is the part that resets. Wallet credits are a separate
  // number beside it: drawing them into the same bar would say they expire with the period.
  const pct = b.included ? Math.min(100, Math.round(((b.included - b.includedLeft) / b.included) * 100)) : 100
  const byKind = d.rows.reduce<Record<string, { credits: number; turns: number }>>((acc, r) => {
    const k = acc[r.kind] ?? { credits: 0, turns: 0 }
    acc[r.kind] = { credits: k.credits + r.credits, turns: k.turns + r.turns }
    return acc
  }, {})

  async function buyPack(pack: string) {
    setBusy(true)
    try {
      const r = await buy({ data: { pack, origin: location.origin } })
      if (r.url) location.href = r.url
      else setWanted(true)
    } catch (e) { dialogs.alert({ title: t('dialog.error', 'Something went wrong'), description: e instanceof Error ? e.message : String(e) }) } finally { setBusy(false) }
  }

  async function upgradeTo(plan: 'pro' | 'business') {
    setBusy(true)
    try {
      const r = await checkout({ data: { plan, origin: location.origin } })
      if (r.url) location.href = r.url
      else setAsked(true)
    } catch (e) { dialogs.alert({ title: t('dialog.error', 'Something went wrong'), description: e instanceof Error ? e.message : String(e) }) } finally { setBusy(false) }
  }
  return (
    <div className="min-h-screen bg-ink text-fg antialiased flex">
      <Sidebar user={d.user} credits={(d as any).credits} projects={d.projects} folders={d.folders} used={d.projects.length} limit={d.limit} active="settings" />
      <main className="flex-1 min-w-0 m-2 sm:ml-0 panel-card flex flex-col overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 pt-16 sm:pt-6 pb-16 space-y-8">
          <div>
            <h1 className="font-display text-[24px] font-semibold">{t('account.title', 'Account')}</h1>
            <p className="text-fg-dim text-[13px] mt-1">{t('account.subtitle', 'Plan, usage and model. Generation runs on the platform model by default; Pro and above can bring their own.')}</p>
          </div>
          <section className="rounded-xl border border-edge p-5 space-y-4">
            <AvatarPicker user={d.user} />
            <Row label={t('account.email', 'Email')} value={d.user.email} />
            <Row label={t('account.name', 'Name')} value={d.user.name || '—'} />
            <Row label={t('account.plan', 'Plan')} value={spec.name} />
            <Row label={t('account.model', 'Current model')} value={d.llm.effective || t('account.notConfigured', 'Not configured')} />
            <Row label={t('account.projectQuota', 'Project quota')} value={`${d.projects.length} / ${d.limit}`} />
          </section>

          {/* Appearance lives here rather than in a corner of every page: it is set once, and a
              control repeated on four screens is four places to look for it. */}
          <section className="rounded-xl border border-edge p-5 space-y-4">
            <h2 className="text-[13.5px] font-medium">{t('settings.appearance', 'Appearance')}</h2>
            <div className="flex items-center justify-between gap-4">
              <span className="text-[13.5px] text-fg-dim">{t('settings.theme', 'Theme')}</span>
              <ThemeChoice />
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-[13.5px] text-fg-dim">{t('settings.language', 'Language')}</span>
              <LocaleToggle />
            </div>
          </section>

          <section className="rounded-xl border border-edge p-5 space-y-3">
            <div className="flex items-baseline justify-between">
              <p className="text-[14px] font-medium">{t('account.credits', 'Credits this period')}</p>
              <p className="text-[12.5px] text-fg-dim tabular-nums">{t('account.resetsOn', 'Resets on')} {new Date(b.periodEnd).toISOString().slice(0, 10)}</p>
            </div>
            <div className="h-2 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-fg transition-[width]" style={{ width: `${pct}%` }} /></div>
            <p className="text-[13px] text-fg-mid tabular-nums">
              {t('account.used', 'Used')} {b.used} · {t('account.planLeft', 'Plan remaining')} {b.includedLeft} / {b.included}
              {b.bonus > 0 && <> · {t('account.wallet', 'Wallet')} {b.bonus}</>}
              {' · '}{t('account.left', 'Left')} <span className="text-fg font-medium">{b.left}</span>
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1 border-t border-edge/60">
              {Object.entries(byKind).length === 0
                ? <span className="text-[12.5px] text-fg-dim">{t('account.noUsage', 'Nothing used in the last 30 days')}</span>
                : Object.entries(byKind).map(([k, v]) => (
                    <span key={k} className="text-[12.5px] text-fg-mid tabular-nums">
                      {k === 'build_app' ? t('account.kind.build', 'Interface builds') : t('account.kind.chat', 'Chat')} {t('account.turns', '{n} turns').replace('{n}', String(v.turns))} · {t('account.creditsN', '{n} credits').replace('{n}', String(v.credits))}
                    </span>
                  ))}
            </div>
            <p className="text-[12px] text-fg-dim">{t('account.meterNote', 'Credits are metered by the tokens and model tier each turn actually uses; turns on your own model (BYOK) cost nothing.')}</p>
          </section>

          {/* Top-ups. Separate from the upgrade block on purpose: needing more credits this month
              is a different problem from needing a bigger plan, and answering it with "subscribe to
              Business" is how you lose the person who just wanted to finish what they started. */}
          <section className="rounded-xl border border-edge p-5 space-y-4">
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <p className="text-[14px] font-medium">{t('account.packs.title', 'Buy credits')}</p>
                <p className="text-[12.5px] text-fg-dim mt-0.5">{t('account.packs.sub', 'Bought credits go to a wallet that does not expire with the period, and are only spent once the plan\u2019s monthly allowance is gone.')}</p>
              </div>
              {b.bonus > 0 && <p className="text-[12.5px] text-fg-mid tabular-nums shrink-0">{t('account.wallet', 'Wallet')} {b.bonus}</p>}
            </div>
            <div className="grid sm:grid-cols-3 gap-3">
              {CREDIT_PACKS.map((p) => (
                <div key={p.id} className="rounded-lg border border-edge p-4">
                  <p className="text-[20px] font-semibold tabular-nums leading-none">{p.credits}<span className="text-[12px] text-fg-dim font-normal"> {t('account.creditsUnit', 'credits')}</span></p>
                  <p className="text-[12px] text-fg-dim mt-1.5 tabular-nums">${p.price} · ${(p.price / p.credits).toFixed(3)} / {t('account.creditsUnit', 'credits')}</p>
                  <Button variant="outline" className="w-full mt-3" onClick={() => buyPack(p.id)} disabled={busy || wanted}>
                    {wanted ? t('account.noted', 'Noted, we will be in touch') : t('account.buy', 'Buy')}
                  </Button>
                </div>
              ))}
            </div>
            {d.grants.length > 0 && (
              <div className="pt-1 border-t border-edge/60 space-y-1">
                {d.grants.map((g) => (
                  <p key={`${g.createdAt}-${g.credits}`} className="text-[12px] text-fg-dim tabular-nums">
                    {new Date(g.createdAt).toISOString().slice(0, 10)} · {g.source === 'purchase' ? t('account.buy', 'Buy') : t('account.granted', 'Granted')} {g.credits} {t('account.creditsUnit', 'credits')}
                    {g.amountUsd > 0 && ` · $${g.amountUsd}`}
                  </p>
                ))}
              </div>
            )}
          </section>
          <ModelSection llm={d.llm} />

          {paid ? (
            <section className="rounded-xl border border-edge p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-[14px] font-medium">{t('account.subscription', 'Subscription')}</p>
                <p className="text-[12.5px] text-fg-dim mt-0.5">{spec.name} · ${spec.price}{t('account.perMonth', '/mo')} · {t('account.creditsPerMonth', '{n} credits a month').replace('{n}', String(spec.credits))}</p>
              </div>
              {d.billing
                ? <Button variant="ghost" onClick={() => portal({ data: { origin: location.origin } }).then((r) => { location.href = r.url }).catch((e) => dialogs.alert({ title: t('dialog.error', 'Something went wrong'), description: e.message }))}>{t('account.manage', 'Manage subscription')}</Button>
                : <Link to="/pricing" className="text-[13px] text-fg-mid hover:text-fg underline underline-offset-4">{t('account.seePricing', 'See pricing')}</Link>}
            </section>
          ) : (
            <section className="rounded-xl border border-edge p-5 space-y-4">
              <div>
                <p className="text-[14px] font-medium">{t('nav.upgrade', 'Upgrade')}</p>
                <p className="text-[12.5px] text-fg-dim mt-0.5">{t('account.upgradeHint', 'Not enough credits, or you want more projects, a direct database connection and a custom domain.')}</p>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                {(['pro', 'business'] as const).map((p) => (
                  <div key={p} className="rounded-lg border border-edge p-4">
                    <p className="text-[13px] font-medium">{PLANS[p].name}</p>
                    <p className="text-[20px] font-semibold tabular-nums mt-0.5">${PLANS[p].price}<span className="text-[12px] text-fg-dim font-normal">{t('account.perMonth', '/mo')}</span></p>
                    <p className="text-[12px] text-fg-dim mt-1">{t('account.creditsN', '{n} credits').replace('{n}', String(PLANS[p].credits))} · {t('account.projectsN', '{n} projects').replace('{n}', String(PLANS[p].projects))}</p>
                    <Button className="w-full mt-3" onClick={() => upgradeTo(p)} disabled={busy || asked}>
                      {asked ? t('account.noted', 'Noted, we will be in touch') : t('account.upgradeTo', 'Upgrade to {plan}').replace('{plan}', PLANS[p].name)}
                    </Button>
                  </div>
                ))}
              </div>
              <Link to="/pricing" className="inline-block text-[12.5px] text-fg-mid hover:text-fg underline underline-offset-4">{t('account.comparePlans', 'Compare all plans')}</Link>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between text-[13.5px]"><span className="text-fg-dim">{label}</span><span className="tabular-nums">{value}</span></div>
}

/**
 * Bring your own model. Paid plans only: on Free this shows what the feature is and points at
 * pricing rather than pretending the fields are editable.
 */
function ModelSection({ llm }: { llm: Awaited<ReturnType<typeof getSettings>> }) {
  const t = useT()
  const save = useServerFn(saveSettings)
  const clear = useServerFn(clearSettings)
  const router = useRouter()
  const [baseUrl, setBaseUrl] = useState(llm.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(llm.model)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  if (!llm.canByok)
    return (
      <section className="rounded-xl border border-edge p-5 flex flex-col sm:flex-row items-start sm:justify-between gap-4">
        <div>
          <p className="text-[14px] font-medium">{t('account.byok.title', 'Bring your own model')}</p>
          <p className="text-[12.5px] text-fg-dim mt-1 max-w-md leading-relaxed">
            {t('account.byok.locked', 'Point Lovbase at your own OpenAI-compatible endpoint and key, stored AES-GCM encrypted. Available on Pro and above. You are currently on the platform model.')}
          </p>
        </div>
        <Link to="/pricing" className="shrink-0 inline-flex items-center h-8 px-3.5 rounded-lg bg-fg text-ink text-[12.5px] font-medium">{t('account.byok.unlock', 'Upgrade to unlock')}</Link>
      </section>
    )

  async function submit() {
    setBusy(true); setMsg('')
    try {
      await save({ data: { baseUrl, apiKey, model } })
      setApiKey(''); setMsg(t('account.byok.saved', 'Saved. Generation now runs on your own model.')); router.invalidate()
    } catch (e) { setMsg(e instanceof Error ? e.message.replace(/^LIMIT:/, '') : String(e)) } finally { setBusy(false) }
  }

  return (
    <section className="rounded-xl border border-edge p-5 space-y-4">
      <div>
        <p className="text-[14px] font-medium">{t('account.byok.title', 'Bring your own model')}</p>
        <p className="text-[12.5px] text-fg-dim mt-1">{t('account.byok.hint', 'Any OpenAI-compatible endpoint. The key is stored encrypted and used only for your own generation. Leave it empty to fall back to the platform model.')}</p>
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <label className="block"><span className="eyebrow block mb-1.5">Base URL</span>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="font-mono" /></label>
        <label className="block"><span className="eyebrow block mb-1.5">API key</span>
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={llm.keyUnreadable ? t('account.byok.reenter', 'Enter it again') : llm.hasKey ? t('account.byok.keySaved', 'Saved; leave empty to keep') : 'sk-…'} className="font-mono" /></label>
        <label className="block"><span className="eyebrow block mb-1.5">{t('account.byok.model', 'Model')}</span>
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-5.2 / claude-sonnet-5" className="font-mono" /></label>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={submit} disabled={busy || !baseUrl || !model}>{t('account.save', 'Save')}</Button>
        {llm.keyUnreadable && (
          <p className="text-[12.5px] text-amber-600 dark:text-amber-500">
            {t('account.byok.unreadable', 'The saved key can no longer be decrypted (the encryption key changed), so the platform model is in use. Enter the key once more to restore it.')}
          </p>
        )}
        {(llm.baseUrl || llm.hasKey) && (
          <Button variant="ghost" onClick={() => clear().then(() => { setBaseUrl(''); setModel(''); setApiKey(''); router.invalidate() })}>
            {t('account.byok.clear', 'Clear and go back to the platform model')}
          </Button>
        )}
        {msg && <span className="text-[12.5px] text-fg-mid">{msg}</span>}
      </div>
      <p className="text-[12px] text-fg-dim">{t('account.byok.note', 'Credits still count as usual: a turn is still 1 credit, because we are still running the sandbox and the database.')}</p>
    </section>
  )
}
