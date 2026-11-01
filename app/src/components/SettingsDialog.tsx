import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { Cpu, CreditCard, Link2, SlidersHorizontal, User, X } from 'lucide-react'
import { accountStorage, billingPortal, buyCredits, getSettings, myCredits } from '../functions'
import { CREDIT_PACKS, planOf, type CreditPack } from '@lovbase/core/plans'
import { Button } from '@/components/ui/button'
import { useT } from '../lib/i18n'
import { useDialogs } from './Dialogs'
import { track } from '../lib/posthog'
import { savePagePosition } from '../lib/page-navigation'
import { AvatarPicker } from './AvatarPicker'
import { NotificationSettings } from './BuildNotifications'
import { ThemeChoice } from './ThemeChoice'
import { LocaleToggle } from './LocaleToggle'
import { GoogleConnections } from './SheetsIntegration'
import { McpAuthorizedClients } from './McpAuthorizedClients'
import { McpDialog } from './McpDialog'
import { UpgradeButton } from './UpgradeButton'
import { ByokSettings } from './ByokSettings'
import { Group, Item } from './settings-rows'

export const SETTINGS_TABS = ['account', 'preferences', 'billing', 'model', 'integrations'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

const OPEN_EVENT = 'lovbase:settings'

/**
 * Settings are a dialog over whatever page you are on, not a page of their own: you open them to
 * change one thing and go back to what you were doing. Anything can open them at a tab with this.
 */
export function openSettings(tab: SettingsTab = 'account') {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { tab } }))
}

/** `/settings` and links from outside (Stripe, OAuth returns) arrive as `?settings=<tab>`. */
export function settingsUrl(tab: SettingsTab, rest = '') {
  return `/home?settings=${tab}${rest ? `&${rest}` : ''}`
}

type Data = {
  llm: Awaited<ReturnType<typeof getSettings>>
  credits: Awaited<ReturnType<typeof myCredits>>
  storage: Awaited<ReturnType<typeof accountStorage>>
}

/** Mounted once, in the sidebar, so every signed-in page can open it. */
export function SettingsDialog({ used, limit }: { used: number; limit: number }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<SettingsTab>('account')
  const [data, setData] = useState<Data | null>(null)
  const loadSettings = useServerFn(getSettings)
  const loadCredits = useServerFn(myCredits)
  const loadStorage = useServerFn(accountStorage)

  const load = useCallback(async () => {
    const [llm, credits, storage] = await Promise.all([loadSettings(), loadCredits(), loadStorage()])
    setData({ llm, credits, storage })
  }, [loadSettings, loadCredits, loadStorage])

  useEffect(() => {
    const show = (next: SettingsTab) => { setTab(next); setOpen(true); void load() }
    const onEvent = (e: Event) => show((e as CustomEvent<{ tab?: SettingsTab }>).detail?.tab ?? 'account')
    window.addEventListener(OPEN_EVENT, onEvent)
    // Arriving from a link: open, then drop the parameter so a reload does not reopen it.
    const params = new URLSearchParams(window.location.search)
    const asked = params.get('settings') as SettingsTab | null
    if (asked) {
      show(SETTINGS_TABS.includes(asked) ? asked : 'account')
      params.delete('settings')
      const q = params.toString()
      window.history.replaceState(window.history.state, '', window.location.pathname + (q ? `?${q}` : '') + window.location.hash)
    }
    return () => window.removeEventListener(OPEN_EVENT, onEvent)
  }, [load])

  const nav: { id: SettingsTab; label: string; icon: ReactNode }[] = [
    { id: 'account', label: t('settings.tab.account', 'Account'), icon: <User /> },
    { id: 'preferences', label: t('settings.tab.preferences', 'Preferences'), icon: <SlidersHorizontal /> },
    { id: 'billing', label: t('settings.tab.billing', 'Plan & credits'), icon: <CreditCard /> },
    { id: 'model', label: t('settings.tab.model', 'Model'), icon: <Cpu /> },
    { id: 'integrations', label: t('settings.tab.integrations', 'Integrations'), icon: <Link2 /> },
  ]
  const current = nav.find((n) => n.id === tab)!

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] max-w-[1040px] h-[min(760px,calc(100vh-2rem))] rounded-2xl bg-panel text-fg ring-1 ring-foreground/10 shadow-2xl overflow-hidden flex max-sm:flex-col outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[.98] data-closed:animate-out data-closed:fade-out-0">
          <nav className="sm:w-56 shrink-0 bg-ink/60 sm:border-r border-edge p-3 flex flex-col gap-1 max-sm:flex-row max-sm:overflow-x-auto max-sm:border-b">
            <DialogPrimitive.Title className="max-sm:hidden px-2.5 pt-1.5 pb-3 text-[12px] font-medium text-fg-dim">{t('settings.title', 'Settings')}</DialogPrimitive.Title>
            {nav.map((n) => (
              <button key={n.id} type="button" onClick={() => setTab(n.id)} aria-current={tab === n.id ? 'page' : undefined}
                className={`w-full max-sm:w-auto flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-[13px] whitespace-nowrap transition-colors [&_svg]:size-[15px] [&_svg]:shrink-0 ${tab === n.id ? 'bg-panel text-fg font-medium shadow-[0_1px_2px_rgba(0,0,0,.06)] ring-1 ring-edge' : 'text-fg-mid hover:text-fg hover:bg-panel/70'}`}>
                {n.icon}{n.label}
              </button>
            ))}
          </nav>
          <div className="flex-1 min-w-0 overflow-y-auto">
            <div className="max-w-[680px] px-6 sm:px-12 py-10">
              <h2 className="text-[22px] font-semibold tracking-tight mb-8">{current.label}</h2>
              {!data ? <p className="text-[14px] text-fg-dim">{t('common.loading', 'Loading…')}</p>
                : tab === 'account' ? <AccountPanel data={data} used={used} limit={limit} />
                : tab === 'preferences' ? <PreferencesPanel />
                : tab === 'billing' ? <BillingPanel data={data} onChange={load} close={() => setOpen(false)} />
                : tab === 'model' ? <ByokSettings llm={data.llm} onUpgrade={() => setOpen(false)} onChange={load} compact />
                : <IntegrationsPanel />}
            </div>
          </div>
          <DialogPrimitive.Close aria-label={t('common.close', 'Close')}
            className="absolute top-3 right-3 size-8 grid place-items-center rounded-lg text-fg-dim hover:text-fg hover:bg-panel-2 transition-colors cursor-pointer">
            <X className="size-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function AccountPanel({ data, used, limit }: { data: Data; used: number; limit: number }) {
  const t = useT()
  const user = data.llm.user
  return (
    <>
      <Group title={t('settings.profile', 'Profile')}>
        <div className="py-4"><AvatarPicker user={user} /></div>
        <Item title={t('account.name', 'Name')}>{user.name || '—'}</Item>
        <Item title={t('account.email', 'Email')}>{user.email}</Item>
      </Group>
      <Group title={t('settings.workspace', 'Workspace')}>
        <Item title={t('account.plan', 'Plan')}>{planOf(user.plan).name}</Item>
        <Item title={t('account.projectQuota', 'Project quota')}><span className="tabular-nums">{used} / {limit}</span></Item>
        <Item title={t('account.model', 'Current model')}><span className="font-mono text-[13px]">{data.llm.effective || t('account.notConfigured', 'Not configured')}</span></Item>
      </Group>
    </>
  )
}

function PreferencesPanel() {
  const t = useT()
  return (
    <>
      <Group title={t('settings.appearance', 'Appearance')}>
        <Item title={t('settings.theme', 'Theme')}><ThemeChoice /></Item>
        <Item title={t('settings.language', 'Language')}><LocaleToggle /></Item>
      </Group>
      <Group title={t('settings.notifications', 'Notifications')}>
        <Item title={t('notifications.desktop', 'Push notifications')} hint={t('settings.pushHint', 'When a build finishes, even with the page closed.')}><NotificationSettings bare /></Item>
      </Group>
    </>
  )
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

function BillingPanel({ data, onChange, close }: { data: Data; onChange: () => void; close: () => void }) {
  const t = useT()
  const dialogs = useDialogs()
  const portal = useServerFn(billingPortal)
  const buy = useServerFn(buyCredits)
  const [busy, setBusy] = useState(false)
  const { balance: b, rows, grants, billing, subscription } = data.credits
  const user = data.llm.user
  const spec = planOf(user.plan)
  const paid = user.plan !== 'free'
  // The bar is the allowance, the part that resets. Wallet credits are a separate number beside
  // it: drawing them into the same bar would say they expire with the period.
  const pct = b.included ? Math.min(100, Math.round(((b.included - b.includedLeft) / b.included) * 100)) : 100
  const byKind = rows.reduce<Record<string, { credits: number; turns: number }>>((acc, r) => {
    const k = acc[r.kind] ?? { credits: 0, turns: 0 }
    acc[r.kind] = { credits: k.credits + r.credits, turns: k.turns + r.turns }
    return acc
  }, {})
  const fail = (e: unknown) => dialogs.alert({ title: t('dialog.error', 'Something went wrong'), description: e instanceof Error ? e.message : String(e) })

  async function buyPack(pack: CreditPack['id']) {
    setBusy(true)
    const product = CREDIT_PACKS.find((p) => p.id === pack)
    const props = { purchase_type: 'credit_pack', product: pack, credits: product?.credits, price: product?.price, source: 'settings' }
    track('billing_option_clicked', { ...props, stage: 'checkout_attempt' })
    try {
      const r = await buy({ data: { pack } })
      track('billing_checkout_created', props)
      savePagePosition()
      location.href = r.url
    } catch (e) { track('billing_checkout_error', { ...props, error: e instanceof Error ? e.message : String(e) }); fail(e) }
    finally { setBusy(false); onChange() }
  }

  return (
    <>
      <Group title={t('settings.plan', 'Plan')}>
        <Item title={<span className="font-medium">{spec.name}</span>}
          hint={paid
            ? <>${subscription.interval === 'year' ? spec.yearlyPrice * 12 : spec.price}{subscription.interval === 'year' ? t('billing.perYear', '/year') : t('account.perMonth', '/mo')} · {t('account.creditsPerMonth', '{n} credits a month').replace('{n}', String(spec.credits))}
              {subscription.paidUntil && <> · {subscription.cancelAtPeriodEnd || subscription.status === 'canceled' ? t('billing.endsOn', 'Available until') : t('billing.paidUntil', 'Paid through')} {subscription.paidUntil.slice(0, 10)}</>}</>
            : t('account.creditsPerMonth', '{n} credits a month').replace('{n}', String(spec.credits))}>
          <span className="flex items-center gap-4">
            <Link to="/pricing" search={{ billing: 'monthly' }} onClick={close} className="text-[13px] text-fg-mid hover:text-fg">{t('account.comparePlans', 'Compare plans')}</Link>
            {billing.enabled && subscription.hasCustomer
              ? <Button variant="outline" size="sm" onClick={() => portal().then((r) => { location.href = r.url }).catch(fail)}>{t('account.manage', 'Manage subscription')}</Button>
              : user.plan !== 'business' && <UpgradeButton plan={user.plan} source="settings" className="inline-flex items-center h-8 px-3.5 rounded-lg bg-accent text-on-accent text-[13px] font-medium">{t('nav.upgradePlan', 'Upgrade plan')}</UpgradeButton>}
          </span>
        </Item>
        {['past_due', 'unpaid'].includes(subscription.status ?? '') && <p className="py-3 text-[13px] text-red-500">{t('billing.pastDue', 'Renewal payment failed. Update your payment method to continue.')}</p>}
      </Group>

      <Group title={t('account.credits', 'Credits this period')}>
        <div className="py-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <p className="tabular-nums"><span className="text-[24px] font-semibold tracking-tight">{b.left}</span><span className="text-[13px] text-fg-dim"> {t('account.left', 'Left')}</span></p>
            <p className="text-[13px] text-fg-dim tabular-nums">{t('account.resetsOn', 'Resets on')} {new Date(b.periodEnd).toISOString().slice(0, 10)}</p>
          </div>
          <div className="h-1.5 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-fg transition-[width]" style={{ width: `${pct}%` }} /></div>
          <p className="text-[13px] text-fg-dim tabular-nums">
            {t('account.planLeft', 'Plan remaining')} {b.includedLeft} / {b.included}
            {b.bonus > 0 && <> · {t('account.wallet', 'Wallet')} {b.bonus}</>}
            {Object.entries(byKind).map(([k, v]) => (
              <span key={k}> · {k === 'build_app' ? t('account.kind.build', 'Interface builds') : k === 'composio' ? t('account.kind.composio', 'Composio usage') : t('account.kind.chat', 'Chat')} {v.credits}</span>
            ))}
          </p>
          {b.debt > 0 && <output className="block text-[13px] text-amber-600 dark:text-amber-400">
            {t('refund.accountDebt', 'Refund debt: {debt} credits. {locked} purchased credits are frozen. New purchases first settle this debt; gifted credits remain available.').replace('{debt}', String(b.debt)).replace('{locked}', String(b.lockedPurchased))}
          </output>}
        </div>
      </Group>

      {/* Top-ups sit apart from the plan: needing more credits this month is a different problem
          from needing a bigger plan. */}
      <Group title={t('account.packs.title', 'Buy credits')}>
        {CREDIT_PACKS.map((p) => (
          <Item key={p.id} title={<span className="tabular-nums">{p.credits} {t('account.creditsUnit', 'credits')}</span>} hint={<span className="tabular-nums">${p.price}</span>}>
            <Button variant="outline" size="sm" onClick={() => buyPack(p.id)} disabled={busy || !billing.packs.includes(p.id)}>
              {!billing.packs.includes(p.id) ? t('billing.unavailable', 'Payments coming soon') : t('account.buy', 'Buy')}
            </Button>
          </Item>
        ))}
        <p className="py-3 text-[13px] text-fg-dim">{t('settings.packsNote', 'Bought credits never expire and are used after the monthly allowance.')}</p>
        {grants.map((g) => (
          <p key={`${g.createdAt}-${g.credits}`} className="py-2.5 text-[13px] text-fg-dim tabular-nums">
            {new Date(g.createdAt).toISOString().slice(0, 10)} · {g.source === 'purchase' ? t('account.buy', 'Buy') : t('account.granted', 'Granted')} {g.credits} {t('account.creditsUnit', 'credits')}
            {g.amountUsd > 0 && ` · $${g.amountUsd}`}
          </p>
        ))}
      </Group>

      <Group title={t('storage.title', 'Account storage')}>
        <div className="py-4 space-y-3">
          <p className="text-[14px] tabular-nums">{mb(data.storage.used)} MB <span className="text-fg-dim">/ {(data.storage.limit / 1024 / 1024).toFixed(0)} MB</span></p>
          <div className="h-1.5 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-fg" style={{ width: `${Math.min(100, (data.storage.used / Math.max(1, data.storage.limit)) * 100)}%` }} /></div>
        </div>
      </Group>
    </>
  )
}

function IntegrationsPanel() {
  const t = useT()
  const [mcpOpen, setMcpOpen] = useState(false)
  return (
    <>
      <Group title={t('settings.connections', 'Connected accounts')}>
        <Item title="Google" hint={t('settings.googleHint2', 'Google Sheets and connectors')}><GoogleConnections compact /></Item>
      </Group>
      <Group title="MCP">
        <Item title={t('settings.mcpTools', 'MCP servers')} hint={t('settings.mcpToolsHint', 'Tools Boris can call')}>
          <Button variant="outline" size="sm" onClick={() => setMcpOpen(true)}>{t('settings.manage', 'Manage')}</Button>
        </Item>
      </Group>
      <McpAuthorizedClients />
      <McpDialog open={mcpOpen} onOpenChange={setMcpOpen} initialTab="tools" returnTo="settings" />
    </>
  )
}
