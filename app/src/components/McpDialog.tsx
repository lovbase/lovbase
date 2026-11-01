import { useEffect, useId, useRef, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { McpConnections } from './McpIntegration'
import { McpClientPanel, clientIcon } from './McpClientPanel'
import { getMcpGrants, getMcpServerInfo } from '../functions/mcp-server'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { useT } from '../lib/i18n'

export type McpDialogTab = 'tools' | 'clients'
type ContentProps = { projectId?: string; initialTab: McpDialogTab; returnTo: 'settings' | 'dialog' }

export function McpDialog({ open, onOpenChange, projectId, initialTab = 'clients', returnTo = 'dialog' }: {
  open: boolean; onOpenChange: (open: boolean) => void; projectId?: string
  initialTab?: McpDialogTab; returnTo?: 'settings' | 'dialog'
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[90dvh] min-w-0 flex-col overflow-hidden bg-panel p-5 text-fg sm:max-w-4xl sm:p-8 gap-6">
      <DialogTitle className="sr-only">MCP</DialogTitle>
      {/* Reset drafts, including credentials, whenever the dialog closes. */}
      {open && <McpDialogContent key={`${initialTab}:${returnTo}`} projectId={projectId} initialTab={initialTab} returnTo={returnTo} />}
    </DialogContent>
  </Dialog>
}

function McpDialogContent({ projectId, initialTab, returnTo }: ContentProps) {
  const t = useT(), id = useId()
  const [tab, setTab] = useState(initialTab)
  const scroller = useRef<HTMLDivElement>(null)
  const tabs: { id: McpDialogTab; label: string; description: string }[] = [
    { id: 'tools', label: t('mcpHub.tools', 'Use external tools'), description: t('mcpHub.toolsDescription', 'Add external MCP tools to Lovbase so its built-in AI can use them to find information, work with data, and complete tasks.') },
    { id: 'clients', label: t('mcpHub.clients', 'Use Lovbase elsewhere'), description: t('mcpHub.clientsDescription', 'Add Lovbase to Claude Code, Codex, or Cursor to manage your projects, edit data and code, and build and publish apps from those clients.') },
  ]
  function select(next: McpDialogTab) {
    setTab(next)
    scroller.current?.scrollTo({ top: 0 })
  }
  return <>
    <div className="shrink-0 min-w-0 space-y-4">
      <div role="tablist" aria-label={t('mcpHub.tabs', 'MCP connections')} className="flex flex-wrap gap-x-5 gap-y-1 border-b border-edge pr-5">
        {tabs.map((item, index) => <button key={item.id} type="button" role="tab" id={`${id}-tab-${item.id}`}
          aria-selected={tab === item.id} aria-controls={`${id}-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
          onClick={() => select(item.id)} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[1] : tabs[1 - index]
            select(next.id)
            document.getElementById(`${id}-tab-${next.id}`)?.focus()
          }} className={`cursor-pointer border-b-2 py-3 text-base sm:text-xl font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ${tab === item.id ? 'border-fg text-fg' : 'border-transparent text-fg-dim hover:text-fg'}`}>
          {item.label}
        </button>)}
      </div>
      <DialogDescription className="text-sm sm:text-base leading-7 text-fg-dim">{tabs.find(item => item.id === tab)?.description}</DialogDescription>
    </div>
    <div ref={scroller} className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
      {/* Hidden panels stay mounted during this opening so switching tabs preserves drafts. */}
      <div role="tabpanel" id={`${id}-panel-tools`} aria-labelledby={`${id}-tab-tools`} hidden={tab !== 'tools'} tabIndex={0}>
        <McpConnections projectId={projectId} returnTo={returnTo} />
      </div>
      <div role="tabpanel" id={`${id}-panel-clients`} aria-labelledby={`${id}-tab-clients`} hidden={tab !== 'clients'} tabIndex={0}>
        <ClientSetup />
      </div>
    </div>
  </>
}

function ClientSetup() {
  const t = useT(), info = useServerFn(getMcpServerInfo)
  const [data, setData] = useState<Awaited<ReturnType<typeof getMcpServerInfo>> | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    void info().then(result => { if (current) setData(result) }).catch(() => { if (current) setError(true) })
    return () => { current = false }
  }, [info, attempt])
  if (error) return <div role="alert" className="space-y-3 rounded-xl border border-edge p-4 text-sm">
    <p>{t('mcpHub.loadError', 'Could not load client setup instructions.')}</p>
    <Button variant="outline" onClick={() => { setError(false); setData(null); setAttempt(n => n + 1) }}>{t('connectors.retry', 'Try again')}</Button>
  </div>
  if (!data) return <output className="block py-8 text-sm text-fg-dim">{t('mcpServer.loading', 'Loading…')}</output>
  if (!data.enabled) return <output className="block rounded-xl border border-edge p-4 text-sm text-fg-dim">{t('mcpHub.unavailable', 'Using Lovbase from other clients is not enabled on this installation. Contact your administrator to enable it.')}</output>
  return <div className="space-y-6"><ConnectedClients /><McpClientPanel url={data.url} /></div>
}

/** What the setup steps produced. Refetched on focus, because authorization finishes in another tab. */
function ConnectedClients() {
  const t = useT(), list = useServerFn(getMcpGrants)
  const [grants, setGrants] = useState<Awaited<ReturnType<typeof getMcpGrants>>>([])
  useEffect(() => {
    let current = true
    const load = () => { void list().then(result => { if (current) setGrants(result) }).catch(() => {}) }
    load()
    window.addEventListener('focus', load)
    return () => { current = false; window.removeEventListener('focus', load) }
  }, [list])
  // Re-authorizing registers the client again; grants come newest first, so keep each client's first one.
  const seen = new Set<string>()
  const clients = grants.map(g => ({ id: g.id, lastUsedAt: g.lastUsedAt, name: g.name.replace(/\s*\(lovbase\)$/i, '') }))
    .filter(g => !seen.has(g.name) && !!seen.add(g.name))
  if (!clients.length) return null
  return <section className="space-y-3">
    <h2 className="font-semibold text-base">{t('mcpServer.connected', 'Connected clients')} ({clients.length})</h2>
    <ul className="flex flex-wrap gap-4">
      {clients.map(g => <li key={g.id} className="flex w-24 flex-col items-center gap-2 text-center"
        title={`${t('mcpServer.lastUsed', 'Last used')} ${g.lastUsedAt ? new Date(g.lastUsedAt).toLocaleString() : '—'}`}>
        <span className="grid size-14 place-items-center rounded-xl border border-edge bg-panel [&>svg]:size-7">{clientIcon(g.name)}</span>
        <span className="w-full truncate text-sm">{g.name}</span>
      </li>)}
    </ul>
  </section>
}
