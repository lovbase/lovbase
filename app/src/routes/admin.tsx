import { Fragment, useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { adminGrantCredits, adminInterest, adminOverview, adminSetAdmin, adminSetPlan, getProjects, usageDetail } from '../functions'
import { PLANS, PLAN_IDS, planOf, type Plan } from '@lovbase/core/plans'
import { Sidebar } from '../components/Sidebar'
import { Switch } from '@/components/ui/switch'
import { useDialogs } from '../components/Dialogs'
import { useI18n } from '../lib/i18n'
import { adminRefunds } from '../functions/admin'
import { AdminRefunds } from '../components/AdminRefunds'
import { AdminFeedback } from '../components/AdminFeedback'
import { seoNoIndex } from '../lib/seo'
import { AdminModelSettings } from '../components/AdminModelSettings'

/** The page grew one section at a time into a single long scroll; these are its rooms. */
const ADMIN_TABS = [
  { id: 'overview', label: 'Overview', key: 'admin.tab.overview' },
  { id: 'users', label: 'Users', key: 'admin.tab.users' },
  { id: 'models', label: 'Models', key: 'admin.tab.models' },
  { id: 'billing', label: 'Billing', key: 'admin.tab.billing' },
  { id: 'feedback', label: 'Feedback', key: 'admin.tab.feedback' },
] as const
type AdminTab = (typeof ADMIN_TABS)[number]['id']

export const Route = createFileRoute('/admin')({
  loader: async () => {
    const [a, p, i, refunds] = await Promise.all([adminOverview(), getProjects(), adminInterest(), adminRefunds()])
    return { ...a, projects: p.projects, folders: p.folders, limit: p.limit, interest: i, refunds }
  },
  validateSearch: (s: Record<string, unknown>): { tab?: AdminTab } =>
    ADMIN_TABS.some((x) => x.id === s.tab) ? { tab: s.tab as AdminTab } : {},
  component: Admin,
  head: () => seoNoIndex('Admin · Lovbase'),
})

function Admin() {
  const { t } = useI18n()
  const d = Route.useLoaderData()
  const tab = Route.useSearch().tab ?? 'overview'
  const dialogs = useDialogs()
  const router = useRouter()
  const setPlan = useServerFn(adminSetPlan)
  const setAdmin = useServerFn(adminSetAdmin)
  const grant = useServerFn(adminGrantCredits)
  const detail = useServerFn(usageDetail)
  const [open, setOpen] = useState<string | null>(null)
  const [rows, setRows] = useState<{ day: string; kind: string; credits: number; turns: number }[]>([])

  /**
   * Hand a user credits — an apology, a trial, a customer who paid another way. The amount is
   * typed rather than a fixed button: those three are never the same number, and "+100 four times"
   * is four ledger rows saying nothing about why. A negative amount takes them back.
   */
  async function grantTo(a: { id: string; email: string; bonus: number }) {
    const answer = await dialogs.prompt({
      title: t('admin.grant.title', 'Grant credits to {email}').replace('{email}', a.email),
      description: t('admin.grant.desc', 'The wallet holds {n} credits now. Bought and granted credits do not expire with the period, and are only spent once the plan allowance is gone. A negative amount takes credits back.').replace('{n}', String(a.bonus)),
      label: t('admin.grant.label', 'Credits'),
      defaultValue: '100',
      confirmLabel: t('admin.grant.confirm', 'Grant'),
    })
    if (answer === null) return
    const amount = Number(answer.trim())
    if (!Number.isInteger(amount) || amount === 0)
      return void dialogs.alert({ title: t('admin.grant.invalid', 'Credits must be a non-zero integer') })
    const reason = await dialogs.prompt({ title: t('admin.grant.title', 'Grant credits to {email}').replace('{email}', a.email),
      label: t('refund.reason', 'Review reason'), description: t('admin.grant.reason', 'Describe the adjustment. For a refund correction, include the Stripe refund ID and what you verified.') })
    if (!reason?.trim()) return
    try {
      await grant({ data: { userId: a.id, amount, note: reason.trim() } })
      router.invalidate()
    } catch (e) { dialogs.alert({ title: t('admin.grant.failed', 'Grant failed'), description: e instanceof Error ? e.message : String(e) }) }
  }

  async function inspect(userId: string) {
    if (open === userId) { setOpen(null); return }
    setOpen(userId); setRows([])
    try { const r = await detail({ data: { userId, days: 30 } }); setRows(r.rows) } catch { /* shown as empty */ }
  }

  return (
    <div className="min-h-screen bg-ink text-fg antialiased flex">
      <Sidebar user={d.user} credits={(d as any).credits} projects={d.projects} folders={d.folders} used={d.projects.length} limit={d.limit} active="admin" />
      <main className="flex-1 min-w-0 m-2 sm:ml-0 panel-card flex flex-col overflow-hidden">
        <div data-page-scroll="admin" className="max-w-5xl mx-auto w-full px-4 sm:px-8 pt-16 sm:pt-4 pb-16 space-y-8 overflow-y-auto">
          <div>
            <h1 className="font-display text-[24px] font-semibold">{t('nav.admin', 'Admin')}</h1>
            <p className="text-fg-dim text-[13px] mt-1">{t('admin.subtitle', 'User plans, admins, the platform model. Only admins can see this page.')}</p>
          </div>

          <nav className="flex items-center gap-1 border-b border-edge -mt-2" aria-label={t('nav.admin', 'Admin')}>
            {ADMIN_TABS.map((x) => (
              <Link key={x.id} to="/admin" search={{ tab: x.id }} replace
                className={`relative h-9 px-3 text-[13px] grid place-items-center transition-colors ${tab === x.id ? 'text-fg font-medium after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-fg' : 'text-fg-dim hover:text-fg'}`}>
                {t(x.key, x.label)}
              </Link>
            ))}
          </nav>

          {tab === 'overview' && <>
          <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
            <Stat label={t('admin.stat.users', 'Users')} value={d.stats.users} />
            <Stat label={t('admin.stat.paying', 'Paying users')} value={d.stats.paying} />
            <Stat label={t('admin.stat.projects', 'Projects')} value={d.accounts.reduce((n, a) => n + a.projects, 0)} />
            <Stat label={t('admin.stat.creditsToday', 'Credits today')} value={d.stats.creditsToday} />
            <Stat label={t('admin.stat.credits30d', 'Credits, 30 days')} value={d.stats.credits30d} />
            <Stat label={t('admin.stat.builds30d', 'Builds, 30 days')} value={d.stats.builds30d} />
          </div>

          <section className="rounded-xl border border-edge overflow-hidden">
            <div className="px-5 py-3 border-b border-edge"><h2 className="text-[14px] font-medium">{t('admin.top.title', 'Top usage · last 30 days')}</h2></div>
            {d.top.length === 0 ? <p className="px-5 py-4 text-[13px] text-fg-dim">{t('admin.noUsage', 'No usage recorded yet')}</p> : (
              <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem] text-[13px]">
                <thead className="text-fg-dim text-left">
                  <tr className="border-b border-edge"><th className="px-5 py-2 font-normal">{t('admin.col.user', 'User')}</th><th className="px-3 py-2 font-normal">{t('account.plan', 'Plan')}</th><th className="px-3 py-2 font-normal">{t('nav.credits', 'Credits')}</th><th className="px-3 py-2 font-normal">{t('admin.col.turns', 'Turns')}</th><th className="px-3 py-2 font-normal">{t('admin.col.lastAt', 'Last turn')}</th></tr>
                </thead>
                <tbody>
                  {d.top.map((u) => (
                    <tr key={u.userId} className="border-b border-edge/60 last:border-0">
                      <td className="px-5 py-2.5">{u.name || u.email}</td>
                      <td className="px-3 py-2.5 text-fg-mid">{planOf(u.plan).name}</td>
                      <td className="px-3 py-2.5 tabular-nums font-medium">{u.credits}</td>
                      <td className="px-3 py-2.5 tabular-nums text-fg-mid">{u.turns}</td>
                      <td className="px-3 py-2.5 tabular-nums text-fg-mid">{new Date(u.lastAt).toISOString().slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </section>

          {/* Payments are off, so every upgrade button is a door that does not open. This is what
              came of that — the only evidence the price is worth anything. People, not clicks:
              one person pressing Pro five times is one person who wants Pro. */}
          <section className="rounded-xl border border-edge overflow-hidden">
            <div className="px-5 py-3 border-b border-edge flex items-baseline gap-2">
              <h2 className="text-[14px] font-medium">{t('admin.interest.title', 'Purchase intent')}</h2>
              <span className="text-[12px] text-fg-dim">{t('admin.interest.sub', 'Payments are not wired up yet; these are the people who clicked and had nowhere to pay')}</span>
            </div>
            {d.interest.recent.length === 0 ? <p className="px-5 py-4 text-[13px] text-fg-dim">{t('admin.interest.none', 'Nobody has clicked a paid entry point yet')}</p> : (
              <>
                <div className="px-5 py-3 flex flex-wrap gap-2 border-b border-edge">
                  {d.interest.summary.map((r) => (
                    <span key={`${r.kind}-${r.target}`}
                      className="inline-flex items-baseline gap-1.5 rounded-full border border-edge bg-panel px-2.5 py-1 text-[12px]">
                      <span className="text-fg">{r.target || (r.kind === 'pack' ? t('admin.interest.pack', 'Credit pack') : t('nav.upgrade', 'Upgrade'))}</span>
                      <span className="text-fg-dim tabular-nums">{t('admin.interest.people', '{n} people').replace('{n}', String(r.people))} · {t('admin.interest.clicks', '{n} clicks').replace('{n}', String(r.clicks))}</span>
                    </span>
                  ))}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[38rem] text-[13px]">
                    <thead className="text-fg-dim text-left">
                      <tr className="border-b border-edge">
                        <th className="px-5 py-2 font-normal">{t('account.email', 'Email')}</th><th className="px-3 py-2 font-normal">{t('admin.col.wants', 'Wants')}</th>
                        <th className="px-3 py-2 font-normal">{t('admin.col.source', 'Source')}</th><th className="px-3 py-2 font-normal">{t('admin.col.currentPlan', 'Current plan')}</th>
                        <th className="px-3 py-2 font-normal">{t('admin.col.time', 'Time')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.interest.recent.map((r) => (
                        <tr key={r.id} className="border-b border-edge/60 last:border-0">
                          <td className="px-5 py-2">{r.email ?? <span className="text-fg-dim">{t('admin.deletedAccount', '(account deleted)')}</span>}</td>
                          <td className="px-3 py-2">{r.target || (r.kind === 'pack' ? t('admin.interest.pack', 'Credit pack') : t('nav.upgrade', 'Upgrade'))}</td>
                          <td className="px-3 py-2 text-fg-dim">{r.source}</td>
                          <td className="px-3 py-2 text-fg-dim">{r.plan ?? '—'}</td>
                          <td className="px-3 py-2 text-fg-dim tabular-nums">{new Date(r.created_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
          </>}
          {tab === 'users' && <>
          <section className="rounded-xl border border-edge overflow-hidden">
            <div className="px-5 py-3 border-b border-edge flex items-baseline justify-between">
              <h2 className="text-[14px] font-medium">{t('admin.stat.users', 'Users')}</h2>
              <span className="text-[12px] text-fg-dim">{PLAN_IDS.map((p) => `${PLANS[p].name} ${t('account.creditsN', '{n} credits').replace('{n}', String(PLANS[p].credits))} / ${t('account.projectsN', '{n} projects').replace('{n}', String(PLANS[p].projects))}`).join(' · ')}</span>
            </div>
            {/* A console table has more columns than a phone has millimetres; it scrolls sideways
                inside its own card rather than squeezing every cell into two characters. */}
            <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-[13px]">
              <thead className="text-fg-dim text-left">
                <tr className="border-b border-edge"><th className="px-5 py-2 font-normal">{t('admin.col.user', 'User')}</th><th className="px-3 py-2 font-normal">{t('nav.projects', 'Projects')}</th><th className="px-3 py-2 font-normal">{t('account.credits', 'Credits this period')}</th><th className="px-3 py-2 font-normal">{t('admin.col.signedUp', 'Signed up')}</th><th className="px-3 py-2 font-normal">{t('account.plan', 'Plan')}</th><th className="px-3 py-2 font-normal">{t('admin.col.admin', 'Admin')}</th></tr>
              </thead>
              <tbody>
                {d.accounts.map((a) => {
                  const cap = planOf(a.plan).credits + a.bonus
                  const pct = cap ? Math.min(100, Math.round((a.used / cap) * 100)) : 0
                  return (
                  <Fragment key={a.id}>
                  <tr key={a.id} className="border-b border-edge/60 last:border-0">
                    <td className="px-5 py-2.5">
                      <button onClick={() => inspect(a.id)} className="text-left cursor-pointer hover:text-fg">
                        <div className="font-medium">{a.name || '—'}</div><div className="text-fg-dim text-[12px]">{a.email}</div>
                      </button>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">{a.projects}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-fg" style={{ width: `${pct}%` }} /></div>
                        <span className="tabular-nums text-[12px] text-fg-mid">{a.used}/{cap}</span>
                        {a.bonus > 0 && <span className="tabular-nums text-[11.5px] text-fg-dim" title={t('admin.walletTitle', 'Wallet (bought or granted, does not expire with the period)')}>+{a.bonus}</span>}
                        <button onClick={() => grantTo(a)}
                          className="text-[11.5px] text-fg-dim hover:text-fg cursor-pointer">{t('admin.grant.button', 'Grant credits')}</button>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-fg-mid">{new Date(a.createdAt).toISOString().slice(0, 10)}</td>
                    <td className="px-3 py-2.5">
                      <div className="inline-flex rounded-lg border border-edge p-0.5">
                        {PLAN_IDS.map((p) => (
                          <button key={p} onClick={() => setPlan({ data: { userId: a.id, plan: p as Plan } }).then(() => router.invalidate())}
                            className={`px-2.5 py-1 rounded-md text-[12px] cursor-pointer ${a.plan === p ? 'bg-fg text-ink' : 'text-fg-mid hover:text-fg'}`}>{PLANS[p].name}</button>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <Switch checked={a.isAdmin} disabled={a.id === d.user.id}
                        onCheckedChange={(v: boolean) => setAdmin({ data: { userId: a.id, isAdmin: v } }).then(() => router.invalidate()).catch((e) => dialogs.alert({ title: t('dialog.error', 'Something went wrong'), description: e.message }))} />
                    </td>
                  </tr>
                  {open === a.id && (
                    <tr key={a.id + ':usage'} className="border-b border-edge/60 bg-panel-2/40">
                      <td colSpan={6} className="px-5 py-3">
                        <p className="text-[12px] text-fg-dim mb-2">{t('admin.usage30d', 'Usage, last 30 days')}</p>
                        {rows.length === 0 ? <p className="text-[12.5px] text-fg-dim">{t('admin.noUsage', 'No usage recorded yet')}</p> : (
                          <div className="flex flex-wrap gap-x-6 gap-y-1">
                            {rows.map((r, i) => (
                              <span key={i} className="text-[12.5px] text-fg-mid tabular-nums">
                                {r.day} · {r.kind === 'build_app' ? t('account.kind.build', 'Interface builds') : r.kind === 'composio' ? t('account.kind.composio', 'Composio usage') : t('account.kind.chat', 'Chat')} {t('account.turns', '{n} turns').replace('{n}', String(r.turns))} · {t('account.creditsN', '{n} credits').replace('{n}', String(r.credits))}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )})}
              </tbody>
            </table>
            </div>
          </section>
          </>}
          {tab === 'models' && <>
          <AdminModelSettings llm={d.llm} />
          {d.rateDiagnostics.length > 0 && (
            <section className="rounded-xl border border-edge overflow-hidden">
              <div className="px-5 py-3 border-b border-edge">
                <h2 className="text-[14px] font-medium">{t('admin.rates.title2', 'Billing rates')}</h2>
                <p className="text-[12px] text-fg-dim mt-0.5">{t('admin.rates.sub', 'What each model costs per million tokens, which is what credits are charged from. Saving above fills in prices the model catalog lists.')}</p>
              </div>
              <div className="grid grid-cols-[1fr_repeat(3,5.5rem)_11rem] items-center px-5 py-2 border-b border-edge text-[11.5px] text-fg-dim">
                <span>{t('admin.rates.model', 'Model')}</span>
                <span className="text-right">{t('admin.rates.in', 'Input')}</span>
                <span className="text-right">{t('admin.rates.out', 'Output')}</span>
                <span className="text-right">{t('admin.rates.cached', 'Cached input')}</span>
                <span className="text-right">{t('admin.rates.status', 'Status')}</span>
              </div>
              <ul className="divide-y divide-edge">
                {d.rateDiagnostics.map((item) => (
                  <li key={item.model} className="grid grid-cols-[1fr_repeat(3,5.5rem)_11rem] items-center px-5 py-2.5 text-[12.5px] tabular-nums">
                    <span className="font-mono truncate">{item.model}</span>
                    <span className="text-right">${item.rate.inPer1M}</span>
                    <span className="text-right">${item.rate.outPer1M}</span>
                    <span className="text-right text-fg-mid">{item.rate.cachedInPer1M != null ? `$${item.rate.cachedInPer1M}` : '—'}</span>
                    <span className="text-right text-[12px]">
                      {item.fallback
                        ? <span className="text-warn" title={t('admin.rates.fallback', 'No configured rate for this model. The fallback rate is being used; verify billing.rates.')}>{t('admin.rates.fallbackShort', 'Fallback price')}</span>
                        : item.rate.cachedInPer1M === undefined
                          ? <span className="text-fg-dim" title={t('admin.rates.noCache', 'No cached-input price configured; cached tokens use the regular input rate.')}>{t('admin.rates.noCacheShort', 'No cache price')}</span>
                          : <span className="text-ok">{t('admin.rates.ok', 'Configured')}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          </>}
          {tab === 'billing' && <>
          <AdminRefunds data={d.refunds} />
          </>}
          {tab === 'feedback' && <>
          <AdminFeedback />
          </>}





        </div>
      </main>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl border border-edge p-4"><p className="text-[12.5px] text-fg-dim">{label}</p><p className="text-[24px] font-semibold tabular-nums mt-1">{value}</p></div>
}
