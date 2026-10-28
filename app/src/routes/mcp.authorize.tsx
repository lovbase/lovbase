import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { getMcpConsent, decideMcpConsent } from '../functions/mcp-server'
import { useT } from '../lib/i18n'
import { Logo } from '../components/Logo'
import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/mcp/authorize')({
  validateSearch: (s: Record<string, unknown>) => ({ request: typeof s.request === 'string' ? s.request : '' }),
  loaderDeps: ({ search }) => ({ request: search.request }),
  loader: ({ deps }) => getMcpConsent({ data: deps }),
  component: Consent,
  head: () => ({ meta: [{ title: 'Authorize MCP · Lovbase' }, { name: 'robots', content: 'noindex,nofollow' }, { name: 'referrer', content: 'no-referrer' }] }),
})
function Consent() {
  const t = useT(), data = Route.useLoaderData(), { request } = Route.useSearch()
  const decide = useServerFn(decideMcpConsent)
  const [busy,setBusy] = useState(false), [error,setError] = useState('')
  async function submit(allow: boolean) {
    setBusy(true); setError('')
    try { const result = await decide({ data: { request, allow } }); window.location.assign(result.redirect) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false) }
  }
  return <main className="min-h-screen bg-ink text-fg flex items-center justify-center p-5">
    <div className="w-full max-w-lg rounded-2xl border border-edge bg-panel p-7 space-y-6">
      <div className="flex items-center gap-2 font-semibold"><Logo />Lovbase</div>
      <div><h1 className="text-xl font-semibold">{t('mcpServer.consentTitle','Authorize MCP client')}</h1><p className="mt-3 text-lg break-words">{data.clientName}</p><p className="mt-1 text-sm text-fg-dim">{data.email}</p></div>
      <p className="text-sm leading-6">{t('mcpServer.consentIntro','This client is requesting access to all projects you own, including future projects:')}</p>
      <ul className="list-disc pl-5 text-sm leading-7 space-y-1">
        <li>{t('mcpServer.permProjects','View and create projects and applications')}</li>
        <li>{t('mcpServer.permData','Read and modify database records and propose schema changes')}</li>
        <li>{t('mcpServer.permCode','Read and edit application source code, build, preview and publish')}</li>
        <li>{t('mcpServer.permAgent','Run the Lovbase Agent using your conversation and credits')}</li>
      </ul>
      <p className="text-xs text-fg-dim leading-6">{t('mcpServer.consentBoundary','Project and application deletion, unpublishing, and destructive schema confirmations stay in Lovbase. Revoke access at any time in Account settings.')}</p>
      {error && <p role="alert" className="text-sm text-warn">{error}</p>}
      <div className="flex justify-end gap-3"><Button variant="outline" disabled={busy} onClick={() => void submit(false)}>{t('mcpServer.deny','Deny')}</Button><Button disabled={busy} onClick={() => void submit(true)}>{busy ? '…' : t('mcpServer.authorize','Authorize')}</Button></div>
    </div>
  </main>
}
