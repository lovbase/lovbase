import { useCallback, useEffect, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { getMcpGrants, revokeMcpGrant } from '../functions/mcp-server'
import { useT } from '../lib/i18n'
import { useDialogs } from './Dialogs'
import { Button } from '@/components/ui/button'
import { Group, Item } from './settings-rows'

export function McpAuthorizedClients() {
  const t = useT(), dialogs = useDialogs()
  const list = useServerFn(getMcpGrants), revoke = useServerFn(revokeMcpGrant)
  const [grants,setGrants] = useState<Awaited<ReturnType<typeof getMcpGrants>> | null>(null)
  const [error,setError] = useState(''), [busy,setBusy] = useState<string | null>(null)
  const reload = useCallback(() => list().then(setGrants).catch(e => setError(e.message)), [list])
  useEffect(() => { void reload() }, [reload])
  const when = (d: string | Date) => new Date(d).toLocaleDateString()
  return <Group title={t('mcpServer.authorized','Authorized MCP clients')}>
    {error && <p role="alert" className="py-3 text-[13px] text-warn">{error} <button onClick={() => { setError(''); void reload() }} className="underline">{t('connectors.retry','Retry')}</button></p>}
    {!grants && !error && <p className="py-3.5 text-[13px] text-fg-dim">{t('mcpServer.loading','Loading…')}</p>}
    {grants?.length === 0 && <p className="py-3.5 text-[13px] text-fg-dim">{t('mcpServer.none','No authorized clients yet.')}</p>}
    {grants?.map(g => <Item key={g.id} title={g.name}
      hint={<>{t('mcpServer.grantedAt','Authorized')} {when(g.createdAt)} · {t('mcpServer.lastUsed','Last used')} {g.lastUsedAt ? when(g.lastUsedAt) : '—'}</>}>
      <Button variant="outline" size="sm" disabled={busy !== null} onClick={async () => {
        // The consequences live in the confirmation, where they are read, not in a paragraph above the list.
        if (!await dialogs.confirm({ title: t('mcpServer.revokeTitle','Revoke this client?'), description: `${g.name} · ${t('mcpServer.grantHint','Clients can access your current and future projects. Revocation blocks new calls; accepted tasks continue and can be stopped in Lovbase.')}`, confirmLabel: t('mcpServer.revoke','Revoke'), destructive: true })) return
        setBusy(g.id); setError('')
        try { await revoke({ data: { id: g.id } }); await reload() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
      }}>{busy === g.id ? '…' : t('mcpServer.revoke','Revoke')}</Button>
    </Item>)}
  </Group>
}
