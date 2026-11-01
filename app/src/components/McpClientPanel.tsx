import { useId, useState, type ReactNode } from 'react'
import { Box, Check, Copy, Plug, Sparkles, Terminal } from 'lucide-react'
import { useT } from '../lib/i18n'
import { mcpClientConfig, type McpClient } from '../lib/mcp-client-config'

function CopyBlock({ text }: { text: string }) {
  const t = useT()
  const [status,setStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  return <div className="relative rounded-xl border border-edge bg-panel-2">
    <button type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setStatus('copied') } catch { setStatus('error') }
    }} className="absolute right-3 top-3 flex items-center gap-1.5 rounded-md border border-edge bg-panel px-2 py-1 text-xs hover:bg-ink cursor-pointer">
      {status === 'copied' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {status === 'copied' ? t('mcpServer.copied','Copied') : t('mcpServer.copy','Copy')}
    </button>
    <pre className="overflow-x-auto p-5 pt-14 sm:pt-5 sm:pr-32 text-[13px] leading-6 font-mono"><code>{text}</code></pre>
    <output className={status === 'error' ? 'block px-5 pb-3 text-warn text-xs' : 'sr-only'}>{status === 'error' ? t('mcpServer.copyError','Could not copy. Select and copy the text manually.') : status === 'copied' ? t('mcpServer.copied','Copied') : ''}</output>
  </div>
}
const icons: Record<Exclude<McpClient,'other'>, ReactNode> = {
  claude: <Sparkles className="size-5 text-orange-500" />,
  codex: <Terminal className="size-5 text-violet-500" />,
  cursor: <Box className="size-5" />,
}
/** Clients name themselves at registration ("Claude Code (lovbase)", "Codex", …), so match loosely. */
export function clientIcon(name: string) {
  const id = (['claude','codex','cursor'] as const).find(c => name.toLowerCase().includes(c))
  return id ? icons[id] : <Plug className="size-5 text-fg-dim" />
}
function Step({ number, children }: { number: number; children: ReactNode }) {
  return <div className="flex items-start gap-3 sm:gap-4"><span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-panel-2 font-semibold text-sm">{number}</span><div className="min-w-0 flex-1 space-y-3 leading-7">{children}</div></div>
}
export function McpClientPanel({ url }: { url: string }) {
  const t = useT()
  const [client,setClient] = useState<McpClient>('claude')
  const panelId = useId()
  const config = mcpClientConfig(url)
  const tabs: { id: McpClient; label: string; icon?: ReactNode }[] = [
    { id: 'claude',label: 'Claude Code',icon: icons.claude },
    { id: 'codex',label: 'Codex',icon: icons.codex },
    { id: 'cursor',label: 'Cursor',icon: icons.cursor },
    { id: 'other',label: t('mcpServer.other','Other') },
  ]
  return <div className="space-y-6">
      <div className="min-w-0 rounded-xl border border-edge p-4 sm:p-6 space-y-6">
        <h2 className="font-semibold text-base">{t('mcpServer.add','Choose your client')}</h2>
        <div role="tablist" aria-label={t('mcpServer.clients','MCP clients')} className="grid grid-cols-2 sm:flex w-full sm:w-fit max-w-full gap-1 rounded-xl bg-panel-2 p-1">
          {tabs.map((tab,i) => <button key={tab.id} id={`${panelId}-tab-${tab.id}`} role="tab" type="button" aria-selected={client === tab.id} aria-controls={`${panelId}-content`} tabIndex={client === tab.id ? 0 : -1}
            onClick={() => setClient(tab.id)} onKeyDown={e => {
              if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return
              e.preventDefault()
              const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
              setClient(tabs[n].id); document.getElementById(`${panelId}-tab-${tabs[n].id}`)?.focus()
            }} className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium cursor-pointer transition-colors ${client === tab.id ? 'bg-panel text-fg shadow-sm' : 'text-fg-dim hover:text-fg'}`}>
            {tab.icon}{tab.label}
          </button>)}
        </div>
        <div id={`${panelId}-content`} role="tabpanel" aria-labelledby={`${panelId}-tab-${client}`} tabIndex={0} className="space-y-6 outline-none" key={client}>
          <Step number={1}>
            <p>{client === 'claude' ? t('mcpServer.terminal','Run this command in your terminal:') : client === 'codex' ? t('mcpServer.addCommand','Add the server:') : client === 'cursor' ? t('mcpServer.cursor','Open Cursor Settings → MCP and add this configuration:') : t('mcpServer.generic','Paste the server URL into your client, or add this JSON to its MCP configuration:')}</p>
            {client === 'other' && <CopyBlock text={url} />}
            <CopyBlock text={client === 'claude' ? config.claude : client === 'codex' ? config.codex : config.json} />
          </Step>
          <Step number={2}>
            <p>{client === 'claude' ? t('mcpServer.claudeAuth','Start Claude Code, run /mcp, then select lovbase → Authenticate. Sign in and approve in your browser.') : client === 'codex' ? t('mcpServer.codexAuth','Log in. Your browser will open to authorize the client:') : client === 'cursor' ? t('mcpServer.cursorAuth','Click Connect next to lovbase in the MCP list, then sign in and approve in your browser.') : t('mcpServer.otherAuth','Your client opens a browser on first connection. Sign in and approve access.')}</p>
            {client === 'codex' && <CopyBlock text={config.login} />}
          </Step>
          {client === 'other' && <div className="space-y-3 border-t border-edge pt-5"><p className="text-sm text-fg-dim">{t('mcpServer.vscode','VS Code uses servers instead of mcpServers:')}</p><CopyBlock text={config.vscode} /></div>}
        </div>
      </div>
      <p className="text-xs text-fg-dim">{t('mcpServer.manageHint','Manage and revoke authorized clients in Account settings. Agent calls use your Lovbase credits.')}</p>
  </div>
}
