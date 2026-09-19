import React, { useCallback, useEffect, useState } from 'react'
import { fetchState, type State } from './api'
import { AgentsTab } from './tabs/AgentsTab'
import { PreviewTab } from './tabs/PreviewTab'
import { DatabaseTab } from './tabs/DatabaseTab'
import { CodeTab } from './tabs/CodeTab'

const TABS = ['Agents', 'Preview', 'Database', 'Code'] as const
type Tab = (typeof TABS)[number]

export function App() {
  const [tab, setTab] = useState<Tab>('Agents')
  const [state, setState] = useState<State | null>(null)
  const [err, setErr] = useState('')

  const refresh = useCallback(() => {
    fetchState().then(setState).catch((e) => setErr(e.message))
  }, [])
  useEffect(refresh, [refresh])

  return (
    <div className="h-screen flex flex-col bg-ink text-stone-300 antialiased">
      <header className="flex items-center px-5 h-13 border-b border-edge shrink-0 gap-8">
        <div className="flex items-center gap-2.5 select-none">
          <Logo />
          <span className="font-mono font-medium tracking-tight text-stone-100">lovbase</span>
          {state && state.ir.entities.length > 0 && (
            <span className="text-stone-500 text-sm">/ {state.ir.appName}</span>
          )}
        </div>
        <nav className="flex gap-6 h-full">
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`relative font-mono text-[13px] lowercase tracking-wide transition-colors ${
                tab === t ? 'text-stone-100' : 'text-stone-500 hover:text-stone-300'
              }`}>
              {t}
              {tab === t && <span className="absolute left-0 right-0 -bottom-[1px] h-[2px] bg-accent" />}
            </button>
          ))}
        </nav>
        {state && (
          <span className={`ml-auto font-mono text-[11px] ${state.hasKey ? 'text-stone-600' : 'text-accent-soft'}`}>
            {state.hasKey ? state.model : '未配置模型 → .env.example'}
          </span>
        )}
      </header>
      <main className="flex-1 min-h-0">
        {err && <div className="p-4 text-accent-soft text-sm font-mono">{err}</div>}
        {state && tab === 'Agents' && <AgentsTab state={state} onChanged={refresh} />}
        {state && tab === 'Preview' && <PreviewTab ir={state.ir} />}
        {state && tab === 'Database' && <DatabaseTab ir={state.ir} />}
        {state && tab === 'Code' && <CodeTab state={state} />}
      </main>
    </div>
  )
}

function Logo() {
  return <img src="/logo.png" width={22} height={22} alt="" className="select-none" />
}
