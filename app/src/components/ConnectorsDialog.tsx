import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { useRouter } from '@tanstack/react-router'
import { Popover } from '@base-ui/react/popover'
import { Eye, EyeOff, KeyRound, Loader2, MoreHorizontal, Plus, Plug, RefreshCw, Search } from 'lucide-react'
import type { AccountView, AuthMethod, ConnectionApp, ProjectConnectionsView } from '@lovbase/core/connections'
import { connectAccount, disconnectGoogle, getConnectionApps, getConnectionAuth, getConnections, getProjectConnections, refreshConnections, renameConnection, setProjectConnectionDefault, setProjectConnectionEnabled } from '../functions/integrations'
import { useI18n, useT } from '../lib/i18n'
import { openConnectionPopup, type ConnectionPopup } from '../lib/connection-popup'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

export const connectionsChanged = 'lovbase:connections-changed'
const inputClass = 'w-full rounded-lg border border-edge-strong bg-panel px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60'
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
type Auth = Awaited<ReturnType<typeof getConnectionAuth>>

export function ConnectorsDialog({ open, onOpenChange, projectId }: {
  open: boolean; onOpenChange: (open: boolean) => void; projectId?: string
}) {
  const t = useT()
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[90dvh] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-panel p-0 text-fg sm:max-w-[920px]">
      <header className="px-6 pb-5 pt-7 pr-12 sm:px-8 sm:pt-8">
        <DialogTitle className="text-2xl font-semibold tracking-tight">{t('connectors.title', 'Connectors')}</DialogTitle>
        <DialogDescription className="mt-3 text-sm leading-relaxed text-fg-dim">{t('connections.description', 'Manage your connected apps and the projects that can use them.')}</DialogDescription>
      </header>
      {open && <ConnectionsManager key={projectId ?? 'account'} projectId={projectId} />}
    </DialogContent>
  </Dialog>
}

function AppIcon({ name, logo }: { name: string; logo: string | null }) {
  const [failed, setFailed] = useState(false)
  return <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-edge bg-panel sm:size-12">
    {logo?.startsWith('https://') && !failed ? <img src={logo} alt="" referrerPolicy="no-referrer" className="size-7 object-contain" onError={() => setFailed(true)} /> : <span aria-hidden="true" className="text-lg font-semibold text-fg-mid">{name.slice(0, 1) || <Plug className="size-5" />}</span>}
  </span>
}

function ConnectionsManager({ projectId }: { projectId?: string }) {
  const t = useT(), { locale } = useI18n(), router = useRouter()
  const list = useServerFn(getConnections), projectList = useServerFn(getProjectConnections), sync = useServerFn(refreshConnections)
  const disconnect = useServerFn(disconnectGoogle), rename = useServerFn(renameConnection)
  const enable = useServerFn(setProjectConnectionEnabled), setDefault = useServerFn(setProjectConnectionDefault)
  const auth = useServerFn(getConnectionAuth), connect = useServerFn(connectAccount)
  const [state, setState] = useState<ProjectConnectionsView | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [now] = useState(() => Date.now())
  const [picker, setPicker] = useState(false)
  const [starting, setStarting] = useState<Set<string>>(() => new Set())
  const startingRef = useRef(new Set<string>())
  const popups = useRef(new Set<ConnectionPopup>())
  const [form, setForm] = useState<{ auth: Auth; account?: AccountView; scheme?: string } | null>(null)
  const [action, setAction] = useState<{ kind: 'rename' | 'disconnect' | 'projects'; account: AccountView } | null>(null)
  const [label, setLabel] = useState('')
  const refresh = useCallback(async () => {
    const next = projectId ? await projectList({ data: { projectId } }) : { ...await list(), enabledIds: [], defaults: {}, selectedId: null }
    setState(next)
  }, [projectId, projectList, list])
  useEffect(() => { let alive = true; void refresh().catch(e => { if (alive) setError(message(e)) }); return () => { alive = false } }, [refresh])
  useEffect(() => () => { for (const popup of popups.current) popup.dispose(); popups.current.clear() }, [])
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1))
    const result = hash.get('connections')
    if (!result) return
    setNotice(result)
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    window.dispatchEvent(new Event(connectionsChanged))
  }, [])
  async function run(fn: () => Promise<unknown>, changed = true, refreshAfter = true) {
    if (busy) return
    setBusy(true); setError('')
    try {
      await fn(); if (refreshAfter) await refresh()
      if (changed) { window.dispatchEvent(new Event(connectionsChanged)); await router.invalidate() }
    } catch (e) { setError(message(e)); await refresh().catch(() => {}) }
    finally { setBusy(false) }
  }
  const groups = new Map<string, AccountView[]>()
  for (const account of state?.connections ?? []) groups.set(account.toolkit, [...groups.get(account.toolkit) ?? [], account])
  const status = (s: string) => t(`connections.status.${s}`, ({ active: 'Connected', pending: 'Awaiting authorization', expired: 'Reconnect required', failed: 'Connection failed', disconnected: 'Disconnect pending' } as Record<string, string>)[s] ?? s)
  const when = (date: string) => {
    const days = Math.floor((now - new Date(date).getTime()) / 86400000)
    return new Intl.RelativeTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { numeric: 'auto' }).format(-days, 'day')
  }
  function createPopup() {
    const popup = openConnectionPopup(result => {
      if (popup) popups.current.delete(popup)
      setNotice(result)
      window.dispatchEvent(new Event(connectionsChanged))
      void Promise.all([refresh(), router.invalidate()]).catch(e => setError(message(e)))
    }, t('connections.openingAuthorization', 'Opening authorization…'))
    if (popup) popups.current.add(popup)
    return popup
  }
  async function start(toolkit: string, key: string, scheme?: string, account?: AccountView) {
    if (startingRef.current.has(key)) return
    const popup = scheme === 'API_KEY' ? null : createPopup()
    if (scheme !== 'API_KEY' && !popup) {
      setError(t('connections.popupBlocked', 'Allow popups for Lovbase, then try connecting again.'))
      return
    }
    startingRef.current.add(key); setStarting(new Set(startingRef.current)); setError(''); setNotice('')
    try {
      const authentication = await auth({ data: { toolkit } })
      const method = authentication.methods.find(m => scheme ? m.scheme === scheme : m.scheme !== 'API_KEY')
      if (!method || method.scheme === 'API_KEY') {
        popup?.close()
        setForm({ auth: authentication, account, scheme: method?.scheme })
        return
      }
      if (!popup) throw new Error(t('connections.popupBlocked', 'Allow popups for Lovbase, then try connecting again.'))
      const result = await connect({ data: {
        toolkit, authScheme: method.scheme, fields: {}, label: account?.label ?? '', projectId,
        returnPath: popup.returnPath, reconnectId: account?.id,
      } })
      if (result.url) popup.navigate(result.url)
      else { popup.close(); await refresh() }
    } catch (e) { popup?.close(); setError(message(e)) }
    finally { startingRef.current.delete(key); setStarting(new Set(startingRef.current)) }
  }
  return <div className="min-h-0 overflow-y-auto px-6 pb-8 sm:px-8">
    <div className="mb-5 mt-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-sm font-semibold text-fg-mid">{t('connections.mine', 'My connections')}</h2>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" disabled={busy || !state?.enabled} aria-label={t('connections.refresh', 'Refresh accounts')} onClick={() => void run(async () => { const synced = await sync(); const next = projectId ? await projectList({ data: { projectId } }) : { ...synced, enabledIds: [], defaults: {}, selectedId: null }; setState({ ...next, syncFailed: synced.syncFailed }) }, false, false)}><RefreshCw className={`size-4 ${busy ? 'animate-spin' : ''}`} /></Button>
        <AppPicker open={picker} onOpenChange={setPicker} disabled={busy || !state?.enabled} connecting={starting.has('new')} onSelect={app => { setPicker(false); void start(app.slug, 'new', app.authSchemes.find(s => s === 'OAUTH2' || s === 'OAUTH1') ?? app.authSchemes.find(s => s === 'API_KEY')) }} />
      </div>
    </div>
    {notice && <output className="mb-4 block rounded-lg bg-panel-2 p-3 text-sm">{notice === 'connected' ? t('connections.connected', 'Account connected. Choose which projects can use it.') : notice === 'identity_changed' ? t('connections.identityChanged', 'A different external account was authorized. The original connection is unchanged. Use Add account to connect the new account.') : t('connections.failed', 'Authorization was cancelled or failed. Try connecting again.')}</output>}
    {error && <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
    {state?.syncFailed && <output className="mb-4 block text-sm text-fg-dim">{t('connections.syncFailed', 'Could not refresh all accounts. Showing saved information; try refreshing again.')}</output>}
    {!state && <Button variant="ghost" disabled={busy} onClick={() => void run(refresh, false)}>{error ? t('connectors.retry', 'Try again') : <><Loader2 className="size-4 animate-spin" />{t('connectors.loading', 'Loading connections…')}</>}</Button>}
    {state && !state.enabled && <p className="mb-4 rounded-xl border border-edge p-4 text-sm text-fg-dim">{t('connectors.unavailable', 'Connections are not configured yet. Contact your administrator to enable them.')}</p>}
    {state && !state.connections.length && <div className="rounded-xl border border-dashed border-edge px-5 py-14 text-center">
      <Plug className="mx-auto mb-4 size-7 text-fg-dim" /><p className="text-sm font-medium">{t('connections.empty', 'No accounts connected yet')}</p>
      <p className="mt-2 text-sm text-fg-dim">{t('connections.emptyHint', 'Connect an app to manage your accounts here.')}</p>
    </div>}
    {!!groups.size && <div className="divide-y divide-edge overflow-hidden rounded-xl border border-edge">
      {[...groups.entries()].map(([slug, accounts]) => <section key={slug} className="p-4 sm:p-6">
        <div className="flex items-center gap-3 sm:gap-4">
          <AppIcon key={accounts[0].logo} name={accounts[0].appName} logo={accounts[0].logo} />
          <h3 className="min-w-0 flex-1 text-base font-semibold"><span className="break-words">{accounts[0].appName}</span> <span className="ml-1 whitespace-nowrap text-sm font-normal text-fg-dim">{t('connections.accountCount', '{n} accounts').replace('{n}', String(accounts.length))}</span></h3>
          <Button variant="ghost" size="sm" disabled={busy || !state?.enabled || starting.has(`add:${slug}`)} aria-busy={starting.has(`add:${slug}`)} onClick={() => void start(slug, `add:${slug}`, accounts[0].authScheme)}>{starting.has(`add:${slug}`) ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}<span className="max-sm:sr-only">{t('connections.add', 'Add account')}</span></Button>
        </div>
        {slug !== 'googlesheets' && <p className="mt-3 text-xs text-fg-dim sm:ml-16">{t('connections.futureTools', 'Connected apps are managed here. Chat tools for this app are not available yet.')}</p>}
        {projectId && state?.enabledIds.some(id => accounts.some(c => c.id === id)) && !state.defaults[slug] && <p className="mt-3 text-xs text-amber-600 sm:ml-16">{t('connections.chooseDefault', 'Choose a default account below.')}</p>}
        <div className="mt-4 space-y-5 sm:ml-16">
          {accounts.map(c => <div key={c.id} className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="break-all text-sm font-medium">{c.identity || c.label || t('connections.unnamed', 'Connected account')}</p>
              {c.identity && c.label && <p className="mt-1 break-all text-xs text-fg-dim">{c.label}</p>}
              {!c.identity && <p className="mt-1 text-xs text-fg-dim">{t('connections.noIdentity', 'Account identity is currently unavailable')}</p>}
              <button type="button" className="mt-2 text-left text-xs text-fg-dim underline-offset-4 hover:underline cursor-pointer" onClick={() => setAction({ kind: 'projects', account: c })}>{t('connections.projectCount', 'Linked to {n} projects').replace('{n}', String(c.projects.length))}</button>
              <p className={`mt-1 text-xs ${c.state === 'active' ? 'text-fg-dim' : 'text-amber-600 dark:text-amber-400'}`}>{status(c.state)}</p>
              {projectId && <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                <label className="inline-flex cursor-pointer items-center gap-2"><input type="checkbox" checked={state?.enabledIds.includes(c.id) ?? false} disabled={busy || !state?.enabled || c.state !== 'active' && !state?.enabledIds.includes(c.id)} onChange={e => void run(() => enable({ data: { projectId, id: c.id, enabled: e.target.checked } }))} />{t('connections.enable', 'Enable for this project')}</label>
                {state?.enabledIds.includes(c.id) && c.state === 'active' && (state.defaults[slug] === c.id ? <span className="rounded border border-edge px-2 py-0.5 text-fg-dim">{t('connections.default', 'Default account')}</span> : <button disabled={busy} className="cursor-pointer text-fg-mid underline underline-offset-4" onClick={() => void run(() => setDefault({ data: { projectId, id: c.id } }))}>{t('connections.makeDefault', 'Set as default')}</button>)}
              </div>}
            </div>
            <time dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString(locale)} className="pt-0.5 text-xs whitespace-nowrap text-fg-dim max-sm:hidden">{when(c.createdAt)}</time>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`${t('connections.actions', 'Account actions')}: ${c.identity || c.label || c.appName}`} />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!state?.enabled || c.state === 'disconnected' || starting.has(`reconnect:${c.id}`)} onClick={() => void start(slug, `reconnect:${c.id}`, c.authScheme, c)}>{t('connections.reconnect', 'Reconnect')}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setLabel(c.label); setAction({ kind: 'rename', account: c }) }}>{t('connections.rename', 'Edit note')}</DropdownMenuItem>
                <DropdownMenuItem className="text-red-600 dark:text-red-400" onClick={() => setAction({ kind: 'disconnect', account: c })}>{t('connections.disconnect', 'Disconnect')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>)}
        </div>
      </section>)}
    </div>}
    {form && <ConnectionForm auth={form.auth} account={form.account} initialScheme={form.scheme} projectId={projectId} createPopup={createPopup} onClose={() => setForm(null)} onSaved={async () => { setForm(null); await run(async () => {}) }} />}
    <Dialog open={!!action} onOpenChange={open => { if (!open && !busy) setAction(null) }}>
      <DialogContent className="bg-panel text-fg sm:max-w-md">
        <DialogTitle>{action?.kind === 'rename' ? t('connections.rename', 'Edit note') : action?.kind === 'projects' ? t('connections.projects', 'Linked projects') : t('connections.disconnect', 'Disconnect')}</DialogTitle>
        <DialogDescription className="break-all text-sm text-fg-dim">{action?.account.identity || action?.account.label || action?.account.appName}</DialogDescription>
        {action?.kind === 'rename' ? <form className="space-y-4" onSubmit={e => { e.preventDefault(); void run(async () => { await rename({ data: { id: action.account.id, label } }); setAction(null) }) }}>
          <input aria-label={t('connections.note', 'Account note')} className={inputClass} maxLength={100} value={label} onChange={e => setLabel(e.target.value)} />
          <Button type="submit" disabled={busy}>{t('connections.save', 'Save')}</Button>
        </form> : <>
          {action?.kind === 'disconnect' && <p className="text-sm leading-relaxed">{t('connections.disconnectHint', 'Disconnecting removes access for the projects below. Previously imported data stays in Lovbase.')}</p>}
          <ul className="max-h-52 space-y-2 overflow-y-auto text-sm">{action?.account.projects.length ? action.account.projects.map(p => <li key={p.id}>{p.name}</li>) : <li className="text-fg-dim">{t('connections.noProjects', 'No linked projects')}</li>}</ul>
          {action?.kind === 'disconnect' && <Button variant="destructive" disabled={busy} onClick={() => void run(async () => { const id = action.account.id; setAction(null); await disconnect({ data: { id } }) })}>{t('connections.disconnect', 'Disconnect')}</Button>}
        </>}
      </DialogContent>
    </Dialog>
  </div>
}

function AppPicker({ open, onOpenChange, onSelect, disabled, connecting }: { open: boolean; onOpenChange: (open: boolean) => void; onSelect: (app: ConnectionApp) => void; disabled: boolean; connecting: boolean }) {
  const t = useT(), list = useServerFn(getConnectionApps)
  const generation = useRef(0)
  const initialLoad = useRef(true)
  const [query, setQuery] = useState(''), [items, setItems] = useState<ConnectionApp[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  useEffect(() => {
    generation.current++
    let alive = true
    setLoading(true); setCursor(null); setError('')
    // Keep the previous results in place while typing; only the final query reaches Composio.
    const timeout = setTimeout(() => { initialLoad.current = false; void list({ data: { query: query.trim() } }).then(r => { if (alive) { setItems(r.items); setCursor(r.cursor) } }).catch(e => { if (alive) setError(message(e)) }).finally(() => { if (alive) setLoading(false) }) }, initialLoad.current ? 0 : 300)
    return () => { alive = false; clearTimeout(timeout) }
  }, [query, list, attempt])
  async function more() {
    if (!cursor || loading) return
    const requestGeneration = generation.current
    setLoading(true); setError('')
    try { const r = await list({ data: { query: query.trim(), cursor } }); if (requestGeneration !== generation.current) return; setItems(current => [...current, ...r.items.filter(a => !current.some(b => b.slug === a.slug))]); setCursor(r.cursor) }
    catch (e) { if (requestGeneration === generation.current) setError(message(e)) } finally { if (requestGeneration === generation.current) setLoading(false) }
  }
  return <Popover.Root open={open} onOpenChange={onOpenChange}>
    <Popover.Trigger render={<Button variant="ghost" disabled={disabled || connecting} aria-busy={connecting} />}>{connecting ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}{t('connections.new', 'Connect new account')}</Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={16} collisionAvoidance={{ side: 'none', align: 'shift', fallbackAxisSide: 'none' }} className="isolate z-50">
        <Popover.Popup className="flex max-h-[min(28rem,var(--available-height))] w-[min(24rem,calc(100vw-2rem))] origin-(--transform-origin) flex-col overflow-hidden rounded-xl border border-edge-strong bg-panel text-fg shadow-xl outline-none">
          <Popover.Title className="sr-only">{t('connections.new', 'Connect new account')}</Popover.Title>
          <Popover.Description className="sr-only">{t('connections.catalogDescription', 'Search apps hosted by Composio.')}</Popover.Description>
          <label className="flex items-center gap-3 border-b border-edge p-4"><Search className="size-4 text-fg-dim" /><input aria-label={t('connections.search', 'Search apps…')} className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none" placeholder={t('connections.search', 'Search apps…')} value={query} onChange={e => setQuery(e.target.value)} /></label>
          <div aria-busy={loading} className="min-h-0 overflow-y-auto p-2">
            <p className="px-3 py-2 text-xs text-fg-dim">{t('connections.hosted', 'Hosted by Composio')}</p>
            {items.map(app => <button key={app.slug} type="button" disabled={loading} onClick={() => onSelect(app)} className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-panel-2 focus-visible:bg-panel-2 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default">
              <AppIcon name={app.name} logo={app.logo} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{app.name}</span>{!app.available && <span className="block text-xs text-fg-dim">{t('connections.adminRequired', 'Additional setup may be required')}</span>}</span>{app.authSchemes.includes('API_KEY') && <KeyRound aria-label={t('connections.keySupported', 'API key supported')} className="size-4 text-fg-dim" />}
            </button>)}
            {loading && <output className="flex items-center justify-center gap-2 p-5 text-sm text-fg-dim"><Loader2 className="size-4 animate-spin" />{t('connectors.loading', 'Loading connections…')}</output>}
            {!loading && !items.length && !error && <p className="p-6 text-center text-sm text-fg-dim">{t('connectors.noResults', 'No matching connectors')}</p>}
            {error && <div role="alert" className="p-3 text-sm text-red-600">{error}<Button variant="ghost" onClick={() => cursor ? void more() : setAttempt(n => n + 1)}>{t('connectors.retry', 'Try again')}</Button></div>}
            {cursor && !loading && <Button variant="ghost" className="w-full" onClick={() => void more()}>{t('connections.more', 'Load more apps')}</Button>}
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}

function ConnectionForm({ auth, account, initialScheme, projectId, createPopup, onClose, onSaved }: { auth: Auth; account?: AccountView; initialScheme?: string; projectId?: string; createPopup: () => ConnectionPopup | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useT(), connect = useServerFn(connectAccount), id = useId()
  const [scheme, setScheme] = useState(account?.authScheme ?? initialScheme ?? auth.methods[0]?.scheme)
  const method: AuthMethod | undefined = auth.methods.find(m => m.scheme === scheme)
  const [fields, setFields] = useState<Record<string, string>>({}), [visible, setVisible] = useState<Record<string, boolean>>({})
  const [label, setLabel] = useState(account?.label ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const ready = !!method && method.fields.every(f => !f.required || (fields[f.name] ?? f.defaultValue ?? '').trim())
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!method || busy) return
    const popup = method.scheme === 'API_KEY' ? null : createPopup()
    if (method.scheme !== 'API_KEY' && !popup) { setError(t('connections.popupBlocked', 'Allow popups for Lovbase, then try connecting again.')); return }
    setBusy(true); setError('')
    try {
      const r = await connect({ data: { toolkit: auth.app.slug, authScheme: method.scheme, fields, label, projectId, returnPath: popup?.returnPath ?? window.location.pathname + window.location.search, reconnectId: account?.id } })
      if (r.url && popup) { popup.navigate(r.url); onClose() }
      else { popup?.close(); setFields({}); await onSaved() }
    } catch (error) { popup?.close(); setError(message(error)) }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto bg-panel p-6 text-fg sm:max-w-lg">
      <div className="flex items-center gap-3 pr-5"><AppIcon name={auth.app.name} logo={auth.app.logo} /><DialogTitle className="text-xl font-semibold">{t(account ? 'connections.reconnectApp' : 'connections.connectApp', account ? 'Reconnect {app}' : 'Connect {app}').replace('{app}', auth.app.name)}</DialogTitle></div>
      <DialogDescription className="text-sm leading-relaxed text-fg-dim">{method?.scheme === 'API_KEY' ? t('connections.keyHint', 'Enter the credentials provided by this app. Composio stores them; Lovbase does not persist the secret values.') : t('connections.oauthHint', 'Authorize this app with Composio in a separate window, then manage the account here.')}</DialogDescription>
      {!auth.methods.length || account && !method ? <p className="rounded-lg bg-panel-2 p-4 text-sm">{t('connections.notSupported', 'This app needs an authentication configuration from your administrator before you can connect it.')}</p> : <form onSubmit={submit} className="space-y-4">
        {!account && auth.methods.length > 1 && <div className="space-y-2 text-sm">
          <label htmlFor={`${id}-auth-method`} className="block">{t('connections.authMethod', 'Authentication method')}</label>
          <Select value={scheme} disabled={busy} onValueChange={value => { if (!value) return; setScheme(value); setFields({}); setVisible({}); setError('') }}>
            <SelectTrigger id={`${id}-auth-method`} className="w-full border-edge-strong bg-panel px-3 text-fg data-[size=default]:h-11 dark:bg-panel dark:hover:bg-panel"><SelectValue>{value => value === 'API_KEY' ? 'API Key' : 'OAuth'}</SelectValue></SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="start" className="bg-panel p-1 text-fg">{auth.methods.map(m => <SelectItem key={m.scheme} value={m.scheme} className="py-2 pl-3">{m.scheme === 'API_KEY' ? 'API Key' : 'OAuth'}</SelectItem>)}</SelectContent>
          </Select>
        </div>}
        {method?.fields.map(f => <div key={f.name} className="space-y-2">
          <label htmlFor={`${id}-${f.name}`} className="block text-sm font-medium">{f.label}{f.required ? ' *' : ''}</label>
          <div className="relative"><input id={`${id}-${f.name}`} autoComplete="off" spellCheck={false} required={f.required} maxLength={16000} disabled={busy} className={`${inputClass} ${f.secret ? 'pr-11' : ''}`} type={f.secret && !visible[f.name] ? 'password' : f.type === 'number' ? 'number' : 'text'} value={fields[f.name] ?? f.defaultValue ?? ''} onChange={e => setFields(v => ({ ...v, [f.name]: e.target.value }))} />{f.secret && <button type="button" className="absolute right-3 top-3 cursor-pointer text-fg-dim" aria-label={visible[f.name] ? t('connections.hide', 'Hide credential') : t('connections.show', 'Show credential')} onClick={() => setVisible(v => ({ ...v, [f.name]: !v[f.name] }))}>{visible[f.name] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>}</div>
          {f.description && <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-dim">{f.description}</p>}
        </div>)}
        {method?.hintUrl && <a className="inline-block text-xs text-fg-mid underline underline-offset-4" href={method.hintUrl} target="_blank" rel="noopener noreferrer">{t('connections.getCredentials', 'Where to get credentials')}</a>}
        {!account && <label className="block space-y-2 text-sm">{t('connections.noteOptional', 'Account note (optional)')}<input className={inputClass} maxLength={100} value={label} disabled={busy} onChange={e => setLabel(e.target.value)} /></label>}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <footer className="flex justify-end gap-2 pt-2"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t('connections.cancel', 'Cancel')}</Button><Button type="submit" disabled={busy || !ready}>{busy && <Loader2 className="size-4 animate-spin" />}{t('connectors.connect', 'Connect')}</Button></footer>
      </form>}
    </DialogContent>
  </Dialog>
}
