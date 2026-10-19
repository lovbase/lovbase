import { useCallback, useEffect, useRef, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Loader2, Plus, Plug, RefreshCw, Server, Trash2 } from 'lucide-react'
import type { McpAuthInput } from '@lovbase/core/mcp'
import { addMcpRegistry, addMcpServer, deleteMcpRegistry, deleteMcpServer, getMcpRegistries, getMcpServers, reconnectMcpServer, setMcpAccountEnabled, setMcpServerEnabled, syncMcpRegistry } from '../functions/integrations'
import { useT } from '../lib/i18n'
import { Button } from './ui/button'

export type McpServerState = Awaited<ReturnType<typeof getMcpServers>>
type ServerItem = McpServerState['servers'][number]
const statusLabels: Record<string, string> = { active: 'Connected', available: 'Available', pending: 'Awaiting authorization', auth_required: 'Authorization required', error: 'Connection failed', unavailable: 'Unavailable', unknown: 'Not connected' }
const inputClass = 'w-full rounded-lg border border-edge-strong bg-panel px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60'

export function McpConnections({ projectId, initialAdd = false, returnTo = 'settings', onStateChange }: {
  projectId?: string; initialAdd?: boolean; returnTo?: 'settings' | 'dialog'; onStateChange?: (state: McpServerState) => void
}) {
  const t = useT()
  const list = useServerFn(getMcpServers)
  const toggle = useServerFn(setMcpServerEnabled)
  const accountToggle = useServerFn(setMcpAccountEnabled)
  const reconnect = useServerFn(reconnectMcpServer)
  const remove = useServerFn(deleteMcpServer)
  const [state, setState] = useState<McpServerState | null>(null)
  const [editing, setEditing] = useState<ServerItem | 'new' | null>(initialAdd ? 'new' : null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)
  const refresh = useCallback(async () => {
    const next = await list({ data: { projectId } })
    if (mounted.current) { setState(next); onStateChange?.(next) }
  }, [list, projectId, onStateChange])
  useEffect(() => {
    mounted.current = true
    void refresh().catch(e => setError(e instanceof Error ? e.message : String(e)))
    const hash = new URLSearchParams(window.location.hash.slice(1))
    if (hash.has('mcp') && hash.get('view') === returnTo) {
      setEditing(null)
      setNotice(hash.get('mcp') === 'connected' ? 'connected' : hash.get('mcp') === 'cancelled' ? 'cancelled' : hash.get('mcp') === 'project_limit' ? 'project_limit' : 'failed')
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    }
    return () => { mounted.current = false }
  }, [refresh, returnTo])

  async function run(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setError('')
    try { await action(); await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function retry(server: ServerItem) {
    const result = await reconnect({ data: { serverId: server.id, projectId, returnTo } })
    if (result.url) window.location.assign(result.url)
    else if (result.error) throw new Error(result.error)
  }
  return <div className="space-y-5">
    {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">{error}<Button variant="ghost" onClick={() => void run(refresh)}>{t('connectors.retry', 'Try again')}</Button></div>}
    {notice && <output className="block rounded-lg bg-panel-2 p-3 text-sm">{notice === 'connected' ? t('mcp.connectedNotice', 'MCP server connected.') : notice === 'project_limit' ? t('mcp.projectLimitNotice', 'Connected, but this project has reached its MCP server limit. Disable another server, then enable this connection.') : notice === 'cancelled' ? t('mcp.cancelledNotice', 'Authorization cancelled. You can reconnect below.') : t('mcp.failedNotice', 'Authorization failed. Reconnect to try again.')}</output>}
    {state && !state.enabled ? <output className="block rounded-xl border border-edge p-4 text-sm text-fg-dim">{t('mcp.unavailable', 'MCP is not enabled on this installation.')}</output>
      : !state ? !error && <output className="flex items-center gap-2 py-8 text-sm text-fg-dim"><Loader2 className="size-4 animate-spin" />{t('connectors.loading', 'Loading connections…')}</output>
      : editing ? <McpServerForm key={editing === 'new' ? 'new' : editing.id} server={editing === 'new' ? undefined : editing} projectId={projectId} returnTo={returnTo}
        onCancel={() => { setEditing(null); void refresh().catch(failure => setError(failure instanceof Error ? failure.message : String(failure))) }} onSaved={async () => { setEditing(null); await refresh() }} />
      : <>
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t('mcp.myServers', 'MCP servers')}</h2><Button onClick={() => { setError(''); setNotice(''); setEditing('new') }}><Plus className="size-4" />{t('mcp.addServer', 'Add MCP server')}</Button></div>
        {state.servers.length === 0 && <p className="rounded-xl border border-dashed border-edge px-4 py-8 text-sm text-fg-dim">{t('mcp.noDirectServers', 'No MCP servers connected yet. Add a server to extend your Agent’s capabilities.')}</p>}
        {state.servers.map(server => <div key={server.id} className="flex flex-wrap items-start gap-3 rounded-xl border border-edge bg-panel p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-edge"><Server className="size-5" /></span>
          <div className="min-w-0 flex-1"><p className="text-sm font-medium">{server.name}</p><p className="mt-1 break-all text-xs text-fg-dim">{server.endpoint}</p>
            <p className="mt-1 text-xs text-fg-dim">{server.registryName && `${server.registryName} · `}{server.authType === 'oauth' ? 'OAuth' : server.authType === 'token' ? t('mcp.tokenAuth', 'Bearer token or API key') : t('mcp.noAuth', 'No authentication')} · {server.accountEnabled ? t(`mcp.status.${server.state}`, statusLabels[server.state] ?? 'Not connected') : t('mcp.status.disabled', 'Disabled')}</p>
            {server.lastError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{server.lastError}</p>}
            {projectId && <label className="mt-3 inline-flex items-center gap-2 text-xs"><input type="checkbox" checked={server.enabled} disabled={busy || !server.accountEnabled || !['active', 'available'].includes(server.state)} onChange={e => void run(() => toggle({ data: { projectId, serverId: server.id, enabled: e.target.checked } }))} />{t('mcp.enableProject', 'Enable for this project')}</label>}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => retry(server))}><RefreshCw className="size-3.5" />{t('mcp.reconnect', 'Reconnect')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(server)}>{t('mcp.configureAuth', 'Authentication')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => accountToggle({ data: { serverId: server.id, enabled: !server.accountEnabled } }))}>{server.accountEnabled ? t('mcp.disable', 'Disable') : t('mcp.enable', 'Enable')}</Button>
            <Button size="icon" variant="ghost" disabled={busy} aria-label={`${t('mcp.delete', 'Delete')} ${server.name}`} onClick={() => void run(() => remove({ data: { serverId: server.id } }))}><Trash2 className="size-4" /></Button>
          </div>
        </div>)}
        <details className="rounded-xl border border-edge p-4"><summary className="cursor-pointer text-sm text-fg-mid">{t('mcp.advancedRegistry', 'Advanced: MCP registries')}</summary><div className="mt-5"><McpRegistryManager onChanged={refresh} /></div></details>
      </>}
  </div>
}

function McpServerForm({ server, projectId, returnTo, onSaved, onCancel }: {
  server?: ServerItem; projectId?: string; returnTo: 'dialog' | 'settings'; onSaved: () => Promise<void>; onCancel: () => void
}) {
  const t = useT()
  const add = useServerFn(addMcpServer), reconnect = useServerFn(reconnectMcpServer)
  const [serverId, setServerId] = useState(server?.id)
  const [name, setName] = useState(server?.name ?? '')
  const [url, setUrl] = useState(server?.endpoint ?? '')
  const [authType, setAuthType] = useState<McpAuthInput['type']>(server?.authType ?? 'oauth')
  const [token, setToken] = useState(''), [customHeader, setCustomHeader] = useState(false), [headerName, setHeaderName] = useState('x-api-key')
  const [clientId, setClientId] = useState(''), [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const ready = name.trim() && url.trim() && (authType !== 'token' || token && (!customHeader || headerName.trim()))
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !ready) return
    setBusy(true); setError('')
    try {
      const auth: McpAuthInput = authType === 'oauth' ? { type: 'oauth', clientId: clientId || undefined, clientSecret: clientSecret || undefined }
        : authType === 'token' ? { type: 'token', token, headerName: customHeader ? headerName : undefined } : { type: 'none' }
      const result = serverId ? await reconnect({ data: { serverId, name, url, auth, projectId, returnTo } }) : await add({ data: { name, url, auth, projectId, returnTo } })
      setServerId(result.serverId)
      if (result.error) setError(result.error)
      else if (result.url) window.location.assign(result.url)
      else await onSaved()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false); setToken(''); setClientSecret('') }
  }
  const options = [
    { value: 'oauth' as const, title: t('mcp.oauthDefault', 'OAuth (default)'), hint: t('mcp.oauthHint', 'Authorize in the next step.') },
    { value: 'token' as const, title: t('mcp.tokenAuth', 'Bearer token or API key'), hint: t('mcp.tokenHint', 'Use a bearer token or API key if the MCP server doesn’t support OAuth.') },
    { value: 'none' as const, title: t('mcp.noAuth', 'No authentication'), hint: t('mcp.noAuthHint', 'Connect without credentials if the server doesn’t require authentication.') },
  ]
  return <form onSubmit={submit} className="space-y-7">
    <div className="flex items-center gap-4 rounded-xl border border-edge bg-panel p-4 shadow-xs"><span className="grid size-12 shrink-0 place-items-center rounded-xl border border-edge"><Plug className="size-7" /></span><div><h2 className="text-base font-semibold">{server ? t('mcp.configureAuth', 'Authentication') : t('mcp.addServer', 'Add MCP server')}</h2><p className="mt-1 text-sm text-fg-dim">{t('mcp.serverHint', 'Connect to a remote MCP server to extend your Agent’s capabilities.')}</p></div></div>
    <fieldset disabled={busy} className="space-y-6 pt-3 disabled:opacity-60">
      <label className="block space-y-2"><span className="text-sm font-medium">{t('mcp.serverName', 'Server name')}</span><input required maxLength={100} value={name} disabled={server?.source === 'registry'} onChange={e => setName(e.target.value)} placeholder={t('mcp.serverPlaceholder', 'My MCP server')} className={inputClass} /></label>
      <label className="block space-y-2"><span className="text-sm font-medium">{t('mcp.serverUrl', 'Server URL')}</span><input required type="url" maxLength={2048} value={url} disabled={server?.source === 'registry'} onChange={e => setUrl(e.target.value)} placeholder="https://mcp.example.com" className={inputClass} /></label>
      <fieldset className="space-y-5"><legend className="mb-3 text-sm font-medium">{t('mcp.authentication', 'Authentication')}</legend>
        {options.map(option => <div key={option.value}>
          <label aria-label={option.title} className="flex cursor-pointer items-start gap-3"><input type="radio" name="mcp-auth" value={option.value} checked={authType === option.value} onChange={() => { setAuthType(option.value); setToken(''); setClientSecret('') }} className="mt-0.5 size-4 accent-blue-600" /><span><span className="block text-sm font-semibold">{option.title}</span><span className="mt-1 block text-sm leading-relaxed text-fg-dim">{option.hint}</span></span></label>
          {option.value === 'token' && authType === 'token' && <div className="ml-7 mt-4 space-y-3">
            <label className="block space-y-1.5"><span className="text-sm">{t('mcp.tokenValue', 'Token or API key')}</span><input required type="password" autoComplete="new-password" value={token} onChange={e => setToken(e.target.value)} className={inputClass} /></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={customHeader} onChange={e => setCustomHeader(e.target.checked)} />{t('mcp.customHeader', 'Use a custom header instead of Bearer')}</label>
            {customHeader && <label className="block space-y-1.5"><span className="text-sm">{t('mcp.headerName', 'Header name')}</span><input required value={headerName} onChange={e => setHeaderName(e.target.value)} placeholder="x-api-key" className={inputClass} /></label>}
          </div>}
          {option.value === 'oauth' && authType === 'oauth' && <details className="ml-7 mt-3 text-xs text-fg-dim"><summary className="cursor-pointer">{t('mcp.oauthAdvanced', 'Advanced: pre-registered OAuth client')}</summary><div className="mt-3 space-y-3">
            <label className="block space-y-1.5"><span>Client ID</span><input value={clientId} onChange={e => setClientId(e.target.value)} className={inputClass} /></label>
            <label className="block space-y-1.5"><span>{t('mcp.clientSecret', 'Client secret (optional)')}</span><input type="password" autoComplete="new-password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} className={inputClass} /></label>
          </div></details>}
        </div>)}
      </fieldset>
    </fieldset>
    {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{t('dialog.cancel', 'Cancel')}</Button><Button type="submit" disabled={busy || !ready}>{busy && <Loader2 className="size-4 animate-spin" />}{authType === 'oauth' ? t('mcp.addAuthorize', 'Add & authorize') : t('mcp.add', 'Add')}</Button></div>
  </form>
}

function McpRegistryManager({ onChanged }: { onChanged: () => Promise<void> }) {
  const t = useT()
  const list = useServerFn(getMcpRegistries), add = useServerFn(addMcpRegistry), sync = useServerFn(syncMcpRegistry), remove = useServerFn(deleteMcpRegistry)
  const [state, setState] = useState<Awaited<ReturnType<typeof getMcpRegistries>> | null>(null)
  const [url, setUrl] = useState(''), [displayName, setDisplayName] = useState(''), [bearerToken, setBearerToken] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { void list().then(setState).catch(() => setError(t('mcp.registryLoadError', 'Could not load registries.'))) }, [list, t])
  async function run(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally {
      setBearerToken('')
      try { setState(await list()); await onChanged() } catch { setError(t('mcp.registryLoadError', 'Could not load registries.')) }
      setBusy(false)
    }
  }
  return <div className="space-y-4">
    <p className="text-sm text-fg-dim">{t('mcp.addHint', 'A registry is a directory of remote MCP servers. Credentials stay encrypted on the server.')}</p>
    <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(async () => { await add({ data: { url, displayName, bearerToken } }); setUrl(''); setDisplayName('') }) }}>
      <label className="block space-y-1"><span className="text-sm">{t('mcp.registryUrl', 'Registry URL')}</span><input type="url" required value={url} onChange={e => setUrl(e.target.value)} className={inputClass} placeholder="https://registry.example.com/v0/servers" /></label>
      <label className="block space-y-1"><span className="text-sm">{t('mcp.displayName', 'Display name (optional)')}</span><input value={displayName} onChange={e => setDisplayName(e.target.value)} className={inputClass} /></label>
      <label className="block space-y-1"><span className="text-sm">{t('mcp.bearerToken', 'Bearer token')} ({t('mcp.optional', 'optional')})</span><input type="password" autoComplete="new-password" value={bearerToken} onChange={e => setBearerToken(e.target.value)} className={inputClass} /></label>
      <Button disabled={busy || !url} type="submit">{t('mcp.addRegistry', 'Add registry')}</Button>
    </form>
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    {state?.registries.map(registry => <div key={registry.id} className="flex items-center gap-2 rounded-lg border border-edge p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm">{registry.displayName}</p><p className="truncate text-xs text-fg-dim">{registry.url}</p>{registry.lastError && <p className="text-xs text-red-600">{registry.lastError}</p>}</div>
      <Button size="icon" variant="ghost" disabled={busy} aria-label={`${t('mcp.sync', 'Sync')} ${registry.displayName}`} onClick={() => void run(() => sync({ data: { id: registry.id } }))}><RefreshCw className="size-4" /></Button>
      <Button size="icon" variant="ghost" disabled={busy} aria-label={`${t('mcp.delete', 'Delete')} ${registry.displayName}`} onClick={() => void run(() => remove({ data: { id: registry.id } }))}><Trash2 className="size-4" /></Button>
    </div>)}
  </div>
}
