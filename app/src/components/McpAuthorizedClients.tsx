import { useCallback, useEffect, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { getMcpGrants, revokeMcpGrant } from '../functions/mcp-server'
import { useT } from '../lib/i18n'
import { useDialogs } from './Dialogs'
import { Button } from '@/components/ui/button'

export function McpAuthorizedClients() {
  const t = useT(), dialogs = useDialogs()
  const list = useServerFn(getMcpGrants), revoke = useServerFn(revokeMcpGrant)
  const [grants,setGrants] = useState<Awaited<ReturnType<typeof getMcpGrants>> | null>(null)
  const [error,setError] = useState(''), [busy,setBusy] = useState<string | null>(null)
  const reload = useCallback(() => list().then(setGrants).catch(e => setError(e.message)), [list])
  useEffect(() => { void reload() }, [reload])
  return <section className="rounded-xl border border-edge p-5 space-y-4">
    <div><h2 className="font-semibold">{t('mcpServer.authorized','Authorized MCP clients')}</h2><p className="mt-1 text-sm text-fg-dim">{t('mcpServer.grantHint','Clients can access your current and future projects. Revocation blocks new calls; accepted tasks continue and can be stopped in Lovbase.')}</p></div>
    {error && <p role="alert" className="text-sm text-warn">{error} <button onClick={() => { setError(''); void reload() }} className="underline">{t('connectors.retry','Retry')}</button></p>}
    {!grants && !error && <p className="text-sm text-fg-dim">{t('mcpServer.loading','Loading…')}</p>}
    {grants?.length === 0 && <p className="text-sm text-fg-dim">{t('mcpServer.none','No authorized clients yet.')}</p>}
    {grants?.map(g => <div key={g.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4">
      <div><p className="text-sm font-medium">{g.name}</p><p className="text-xs text-fg-dim mt-1">{t('mcpServer.grantedAt','Authorized')}: {new Date(g.createdAt).toLocaleString()}</p><p className="text-xs text-fg-dim mt-1">{t('mcpServer.lastUsed','Last used')}: {g.lastUsedAt ? new Date(g.lastUsedAt).toLocaleString() : '—'}</p></div>
      <Button variant="outline" size="sm" disabled={busy !== null} onClick={async () => {
        if (!await dialogs.confirm({ title: t('mcpServer.revokeTitle','Revoke this client?'), description: g.name, confirmLabel: t('mcpServer.revoke','Revoke'), destructive: true })) return
        setBusy(g.id); setError('')
        try { await revoke({ data: { id: g.id } }); await reload() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
      }}>{busy === g.id ? '…' : t('mcpServer.revoke','Revoke')}</Button>
    </div>)}
  </section>
}
