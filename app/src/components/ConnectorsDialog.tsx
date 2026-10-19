import { useEffect, useId, useState, type ReactNode } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { ArrowUpRight, BookOpen, Check, CircleCheck, ChevronRight, Database, FileSpreadsheet, Loader2, LockKeyhole, Plug, Search, ShieldCheck, X } from 'lucide-react'
import { connectGoogle, getConnections, getProjectConnections } from '../functions/integrations'
import { useT } from '../lib/i18n'
import { GoogleConnections, type ConnectionState } from './SheetsIntegration'
import { Button } from './ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

type Filter = 'all' | 'enabled' | 'productivity' | 'google'
type ConnectorPage = 'catalog' | 'details' | 'new'

export function ConnectorsDialog({ open, onOpenChange, projectId }: {
  open: boolean; onOpenChange: (open: boolean) => void; projectId?: string
}) {
  const t = useT()
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent showCloseButton={false} className="flex h-[min(860px,94dvh)] w-[calc(100%-2rem)] max-w-[1200px] gap-0 overflow-hidden rounded-2xl bg-panel p-0 text-fg sm:max-w-[1200px] max-sm:flex-col">
      {open && <ConnectorCatalog key={projectId ?? 'account'} projectId={projectId} />}
      <DialogClose render={<Button variant="ghost" size="icon" className="absolute right-3 top-3" />} aria-label={t('connectors.close', 'Close connectors')}>
        <X className="size-4" />
      </DialogClose>
    </DialogContent>
  </Dialog>
}

function ConnectorCatalog({ projectId }: { projectId?: string }) {
  const t = useT()
  const list = useServerFn(getConnections), projectList = useServerFn(getProjectConnections)
  const [state, setState] = useState<ConnectionState | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState<ConnectorPage>('catalog')
  const [connectionName, setConnectionName] = useState('Google Sheets')
  useEffect(() => {
    let alive = true
    void (projectId ? projectList({ data: { projectId } }) : list()).then(next => {
      if (alive) setState(next)
    }).catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [projectId, projectList, list, attempt])
  const connected = !!state?.connections.some(c => c.state === 'active' && (!projectId || state.selectedId === c.id))
  const description = t('connectors.sheetsDescription', 'Import spreadsheet data and build an app from it.')
  const matches = `Google Sheets ${t('connectors.sheetsSearch', 'spreadsheet tables import')} ${description}`.toLowerCase().includes(query.trim().toLowerCase())
    && (filter !== 'enabled' || connected)
  const filterLabels: Record<Filter, string> = {
    all: t('connectors.all', 'All connectors'), enabled: t('connectors.enabled', 'Enabled'),
    productivity: t('connectors.productivity', 'Productivity'), google: 'Google',
  }
  function filterButton(value: Filter) {
    return <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setPage('catalog') }}
      className={`flex w-full items-center justify-between gap-4 rounded-lg px-3 py-2.5 text-left text-sm transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-ring ${filter === value ? 'bg-panel-2 font-medium text-fg' : 'text-fg-mid hover:bg-panel-2/60'}`}>
      <span>{filterLabels[value]}</span><span className="text-xs font-normal tabular-nums text-fg-dim">{value === 'enabled' ? state ? Number(connected) : '—' : 1}</span>
    </button>
  }
  return <>
    <aside className="flex w-56 shrink-0 flex-col border-r border-edge bg-ink/60 p-3 max-sm:w-full max-sm:border-r-0 max-sm:border-b max-sm:pr-14">
      <label className="flex items-center gap-2 rounded-lg border border-edge-strong bg-panel px-3 py-2.5 focus-within:ring-2 focus-within:ring-ring/30">
        <Search className="size-4 shrink-0 text-fg-dim" />
        <input value={query} onChange={e => { setQuery(e.target.value); setPage('catalog') }} aria-label={t('connectors.search', 'Search connectors')}
          placeholder={t('connectors.search', 'Search connectors')} className="min-w-0 w-full bg-transparent text-sm outline-none" />
      </label>
      <nav aria-label={t('connectors.filters', 'Connector filters')} className="mt-5 space-y-1 max-sm:mt-2 max-sm:flex max-sm:space-y-0">
        {filterButton('enabled')}{filterButton('all')}
        <p className="px-3 pb-2 pt-6 text-xs text-fg-dim max-sm:hidden">{t('connectors.categories', 'Categories')}</p>
        <div className="max-sm:hidden">{filterButton('productivity')}{filterButton('google')}</div>
      </nav>
      <div className="mt-auto border-t border-edge px-3 pt-4 pb-1 max-sm:hidden">
        <div className="flex items-center gap-2 text-xs text-fg-mid"><ShieldCheck className="size-4" />{t('connectors.secure', 'You control access')}</div>
        <p className="mt-2 text-xs leading-relaxed text-fg-dim">{t('connectors.accessHint', 'Connect your account, then choose which projects can use it.')}</p>
        <p className="mt-3 text-[11px] text-fg-dim">Powered by Composio</p>
      </div>
    </aside>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-14 shrink-0 items-center border-b border-edge px-5 py-3 pr-14 sm:px-6 sm:pr-14">
        <DialogTitle className="sr-only">{t('connectors.title', 'Connectors')}{page !== 'catalog' && ' / Google Sheets'}{page === 'new' && ` / ${t('connectors.new', 'New connection')}`}</DialogTitle>
        <nav aria-label={t('connectors.breadcrumb', 'Breadcrumb')} className="min-w-0">
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <li className="flex items-center gap-2">
              <Plug aria-hidden="true" className="size-4 shrink-0 text-fg-dim" />
              {page === 'catalog' ? <span aria-current="page" className="font-medium">{t('connectors.title', 'Connectors')}</span>
                : <button type="button" onClick={() => setPage('catalog')} className="rounded text-fg-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-ring cursor-pointer">{t('connectors.title', 'Connectors')}</button>}
            </li>
            {page !== 'catalog' && <>
              <li aria-hidden="true" className="text-fg-dim">/</li>
              <li>{page === 'details' ? <span aria-current="page" className="font-medium">Google Sheets</span>
                : <button type="button" onClick={() => setPage('details')} className="rounded text-fg-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-ring cursor-pointer">Google Sheets</button>}</li>
            </>}
            {page === 'new' && <><li aria-hidden="true" className="text-fg-dim">/</li><li><span aria-current="page" className="font-medium">{t('connectors.new', 'New connection')}</span></li></>}
          </ol>
        </nav>
      </header>
      <DialogDescription className="sr-only">{t('connectors.dialogDescription', 'Browse connectors and manage the accounts your projects can access.')}</DialogDescription>
      {page === 'new' ? <NewGoogleConnection projectId={projectId} enabled={!!state?.enabled} name={connectionName} onNameChange={setConnectionName} /> :
      <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
        {page === 'details' ? <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-4 rounded-xl border border-edge bg-panel p-4"><SheetsIcon /><div className="min-w-0 flex-1"><h2 className="text-base font-semibold">Google Sheets</h2><p className="mt-1 text-sm text-fg-dim">{description}</p></div><SheetsDocs /></div>
          <div className="flex flex-wrap gap-2 text-xs text-fg-mid">
            <span className="rounded-md border border-edge px-2 py-1">{t('connectors.readOnly', 'Read-only access')}</span>
            <span className="rounded-md border border-edge px-2 py-1">{t('connectors.oneTime', 'One-time import')}</span>
          </div>
          <GoogleConnections projectId={projectId} onStateChange={setState} onCreate={() => setPage('new')} />
          <p className="text-sm leading-relaxed text-fg-dim">{projectId ? t('connectors.nextProject', 'After enabling a connection, paste a Google Sheets link into the project chat to preview and import your data.') : t('connectors.nextAccount', 'After connecting, open a project and enable Google Sheets in its Connectors panel to start importing.')}</p>
        </div> : <>
          <section className="relative overflow-hidden border-b border-edge pb-8 pt-5 text-center sm:pt-8">
            <div aria-hidden="true" className="mb-6 flex items-center justify-center gap-4">
              <span className="grid size-11 place-items-center rounded-xl border border-edge bg-ink text-fg-dim"><Database className="size-5" /></span>
              <span className="h-px w-8 bg-edge-strong" /><SheetsIcon /><span className="h-px w-8 bg-edge-strong" />
              <span className="grid size-11 place-items-center rounded-xl border border-edge bg-ink text-fg-dim"><Plug className="size-5" /></span>
            </div>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-[28px]">{t('connectors.hero', 'Build from what you already use')}</h2>
            <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-fg-dim">{t('connectors.intro', 'Bring your tools and data into Lovbase. Connect an account and turn your spreadsheets into working apps.')}</p>
            <a href="https://docs.google.com/spreadsheets/" target="_blank" rel="noopener noreferrer" className="mt-5 inline-flex items-center gap-1.5 text-xs text-fg-mid underline-offset-4 hover:underline">
              {t('connectors.openSheets', 'Open Google Sheets')}<ArrowUpRight className="size-3.5" />
            </a>
          </section>
          <div className="mb-4 mt-6 flex items-center justify-between text-xs text-fg-dim"><span>{filterLabels[filter]}</span><span>Composio</span></div>
          {error ? <div role="alert" className="rounded-xl border border-edge p-5 text-sm"><p className="text-red-600">{error}</p><Button variant="outline" className="mt-3" onClick={() => { setError(''); setAttempt(n => n + 1) }}>{t('connectors.retry', 'Try again')}</Button></div>
            : !state ? <output className="flex items-center gap-2 py-8 text-sm text-fg-dim"><Loader2 className="size-4 animate-spin" />{t('connectors.loading', 'Loading connections…')}</output>
            : <>
              {!state.enabled && <output className="mb-4 block rounded-lg bg-panel-2 p-3 text-sm text-fg-mid">{t('connectors.unavailable', 'Connections are not configured yet. Contact your administrator to enable them.')}</output>}
              {matches ? <div className="grid gap-3 lg:grid-cols-2">
                <button type="button" onClick={() => setPage('details')} className="group flex items-center gap-3 rounded-xl border border-edge bg-panel p-4 text-left transition-colors hover:border-edge-strong hover:bg-panel-2/40 focus-visible:outline-2 focus-visible:outline-ring cursor-pointer">
                  <span className="relative shrink-0"><SheetsIcon />{connected && <span className="absolute -right-1 -top-1 size-3 rounded-full border-2 border-panel bg-emerald-500" />}</span>
                  <span className="min-w-0 flex-1"><span className="block text-sm font-medium">Google Sheets</span><span className="mt-1 block text-xs leading-relaxed text-fg-dim">{description}</span>
                    {connected && <span className="mt-2 flex items-center gap-1 text-xs text-emerald-600"><Check className="size-3" />{t('connectors.enabled', 'Enabled')}</span>}
                  </span><ChevronRight className="size-4 shrink-0 text-fg-dim group-hover:text-fg" />
                </button>
              </div> : <div className="rounded-xl border border-dashed border-edge px-5 py-10 text-center">
                <Search className="mx-auto mb-3 size-6 text-fg-dim" /><p className="text-sm font-medium">{query.trim() ? t('connectors.noResults', 'No matching connectors') : t('connectors.noneEnabled', 'No connectors enabled yet')}</p>
                <p className="mt-2 text-xs text-fg-dim">{t('connectors.emptyHint', 'Browse all connectors to connect an account and get started.')}</p>
                <Button variant="outline" className="mt-4" onClick={() => { setQuery(''); setFilter('all') }}>{t('connectors.all', 'All connectors')}</Button>
              </div>}
            </>}
        </>}
      </div>}
    </div>
  </>
}

function SheetsIcon() {
  return <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-emerald-600 text-white shadow-sm"><FileSpreadsheet className="size-6" strokeWidth={1.7} /></span>
}

function SheetsDocs() {
  const t = useT()
  return <a href="https://support.google.com/docs/topic/9054603" target="_blank" rel="noopener noreferrer"
    className="inline-flex shrink-0 items-center gap-1.5 rounded text-xs text-fg-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-ring">
    <BookOpen className="size-4" />{t('connectors.docs', 'Docs')}
  </a>
}

function ConnectionSection({ title, summary, complete = true, defaultOpen = false, children }: {
  title: string; summary: ReactNode; complete?: boolean; defaultOpen?: boolean; children: ReactNode
}) {
  return <details open={defaultOpen || undefined} className="group rounded-xl border border-edge bg-panel/50">
    <summary className="flex min-h-[68px] cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-4 focus-visible:outline-2 focus-visible:outline-ring sm:px-5 [&::-webkit-details-marker]:hidden">
      <CircleCheck aria-hidden="true" className={`size-[18px] shrink-0 ${complete ? 'text-emerald-600' : 'text-fg-dim'}`} />
      <span className="text-sm font-medium">{title}</span>
      <span className="ml-auto min-w-0 max-w-[45%] truncate text-right text-xs text-fg-dim sm:text-sm">{summary}</span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-mid transition-transform group-open:rotate-90" />
    </summary>
    <div className="border-t border-edge px-4 py-5 sm:px-5">{children}</div>
  </details>
}

function NewGoogleConnection({ projectId, enabled, name, onNameChange }: {
  projectId?: string; enabled: boolean; name: string; onNameChange: (name: string) => void
}) {
  const t = useT()
  const connect = useServerFn(connectGoogle)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const nameId = useId()
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !enabled || !name.trim()) return
    setBusy(true); setError('')
    try {
      const result = await connect({ data: { label: name.trim(), projectId } })
      window.location.assign(result.url)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col bg-ink/30">
    <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
      <div className="flex items-center gap-3 rounded-xl border border-edge bg-panel p-3 shadow-xs">
        <SheetsIcon /><h2 className="min-w-0 flex-1 text-sm font-semibold">{t('connectors.createSheets', 'Create a new Google Sheets connection')}</h2><SheetsDocs />
      </div>
      <div className="mt-7 space-y-3 sm:mt-9">
        <ConnectionSection title={t('connectors.details', 'Details')} summary={name.trim() || t('sheets.connectionName', 'Connection name')} complete={!!name.trim()} defaultOpen>
          <label htmlFor={nameId} className="mb-2 block text-xs font-medium">{t('sheets.connectionName', 'Connection name')}</label>
          <input id={nameId} required maxLength={100} value={name} onChange={e => onNameChange(e.target.value)} disabled={busy}
            className="w-full max-w-md rounded-lg border border-edge-strong bg-panel px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/30" />
          <p className="mt-2 text-xs leading-relaxed text-fg-dim">{t('connectors.nameHint', 'Choose a name so you can recognize this account later.')}</p>
        </ConnectionSection>
        <ConnectionSection title={t('connectors.configure', 'Configure connection')} summary={t('connectors.scopes', 'Scopes')}>
          <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-fg-dim" /><div>
            <p className="text-sm font-medium">{t('connectors.readOnly', 'Read-only access')}</p>
            <p className="mt-2 text-xs leading-relaxed text-fg-dim">{t('connectors.scopeHint', 'Read spreadsheet data to preview and import it into Lovbase. Your original Google Sheets files will not be modified.')}</p>
          </div></div>
        </ConnectionSection>
        <ConnectionSection title={t('connectors.sharing', 'Sharing')} summary={<span className="inline-flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-xs"><LockKeyhole className="size-3" />{t('connectors.private', 'Private')}</span>}>
          <p className="text-sm font-medium">{t('connectors.onlyYou', 'Only you can manage this connection')}</p>
          <p className="mt-2 text-xs leading-relaxed text-fg-dim">{t('connectors.sharingHint', 'The connection belongs to your account. After authorization, choose which of your projects can use it.')}</p>
        </ConnectionSection>
      </div>
      {!enabled && <output className="mt-5 block rounded-lg bg-panel-2 p-3 text-sm text-fg-mid">{t('connectors.unavailable', 'Connections are not configured yet. Contact your administrator to enable them.')}</output>}
      {error && <p role="alert" className="mt-5 text-sm text-red-600">{error}</p>}
    </div>
    <footer className="flex shrink-0 items-center gap-4 border-t border-edge bg-panel px-5 py-4 sm:px-6">
      <p className="mr-auto text-xs leading-relaxed text-fg-dim">{t('connectors.redirectHint', 'You will be redirected to Google to authorize this connection.')}</p>
      <Button type="submit" disabled={busy || !enabled || !name.trim()} className="h-9 bg-blue-600 px-4 text-white hover:bg-blue-700">
        {busy && <Loader2 className="size-4 animate-spin" />}{busy ? t('connectors.connecting', 'Connecting…') : t('connectors.connect', 'Connect')}
      </Button>
    </footer>
  </form>
}
