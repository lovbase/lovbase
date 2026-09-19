import React, { useEffect, useRef, useState } from 'react'
import { confirm, generate, type State } from '../api'
import type { Change } from '../../shared/diff'
import { isDestructive } from '../../shared/diff'

export function AgentsTab({ state, onChanged }: { state: State; onChanged: () => void }) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState<{ pendingId: string; changes: Change[] } | null>(null)
  const [error, setError] = useState('')
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [state.log.length, pendingConfirm, busy])

  async function send() {
    const message = input.trim()
    if (!message || busy) return
    setBusy(true); setError(''); setInput('')
    try {
      const r = await generate(message)
      if (r.needsConfirmation && r.pendingId) setPendingConfirm({ pendingId: r.pendingId, changes: r.changes })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false); onChanged()
    }
  }

  async function doConfirm() {
    if (!pendingConfirm) return
    setBusy(true)
    try { await confirm(pendingConfirm.pendingId) } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPendingConfirm(null); setBusy(false); onChanged()
    }
  }

  return (
    <div className="h-full flex flex-col max-w-2xl mx-auto">
      <div className="flex-1 overflow-y-auto px-6 py-8 space-y-6">
        {state.log.length === 0 && (
          <div className="mt-28 space-y-3 select-none">
            <p className="text-stone-200 text-xl">用一句话,得到一个真数据库。</p>
            <p className="text-stone-500 text-sm leading-relaxed">
              试试:「做一个客户管理系统,记录客户、联系人和跟进记录」<br />
              之后随时改需求 — 改名、加字段,已有数据一行不丢。
            </p>
          </div>
        )}
        {state.log.map((row) => <LogEntry key={row.id} role={row.role} content={row.content} />)}
        {pendingConfirm && (
          <div className="border border-accent/60 bg-accent/5 rounded-md p-4 text-sm space-y-3">
            <p className="font-mono text-[11px] uppercase tracking-widest text-accent-soft">destructive — 需要确认</p>
            <p className="text-stone-300">以下变更会影响已有数据:</p>
            <ChangeList changes={pendingConfirm.changes} />
            <div className="flex gap-2 pt-1">
              <button onClick={doConfirm} disabled={busy}
                className="px-3.5 py-1.5 bg-accent text-white rounded font-mono text-xs hover:bg-accent-soft disabled:opacity-50">
                确认执行
              </button>
              <button onClick={() => setPendingConfirm(null)}
                className="px-3.5 py-1.5 border border-edge rounded font-mono text-xs text-stone-400 hover:text-stone-200">
                取消
              </button>
            </div>
          </div>
        )}
        {busy && (
          <p className="font-mono text-xs text-stone-500">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse mr-2" />
            compiling…
          </p>
        )}
        {error && <p className="text-sm text-accent-soft font-mono">{error}</p>}
        <div ref={bottom} />
      </div>
      <div className="px-6 pb-6">
        <div className="flex gap-2 bg-panel border border-edge rounded-lg p-1.5 focus-within:border-stone-600 transition-colors">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="描述你要的应用,或要修改的地方…"
            className="flex-1 px-2.5 py-1.5 bg-transparent text-stone-100 placeholder-stone-600 focus:outline-none text-[15px]"
          />
          <button onClick={send} disabled={busy || !input.trim()}
            className="px-4 py-1.5 bg-accent text-white rounded-md font-mono text-xs hover:bg-accent-soft disabled:opacity-30 disabled:hover:bg-accent transition-colors">
            build
          </button>
        </div>
      </div>
    </div>
  )
}

function LogEntry({ role, content }: { role: string; content: any }) {
  if (role === 'user')
    return (
      <div className="flex justify-end">
        <div className="bg-panel border border-edge text-stone-200 rounded-lg px-4 py-2.5 max-w-[85%] text-[15px]">
          {content.message}
        </div>
      </div>
    )
  if (role === 'error')
    return <p className="text-sm text-accent-soft font-mono">✕ {content.message}</p>
  return (
    <div className="text-sm space-y-2.5">
      <p className="font-mono text-[11px] uppercase tracking-widest text-stone-500">{content.note}</p>
      {content.changes?.length > 0 && <ChangeList changes={content.changes} />}
    </div>
  )
}

function ChangeList({ changes }: { changes: Change[] }) {
  return (
    <ul className="border border-edge rounded-md divide-y divide-edge overflow-hidden">
      {changes.map((c, i) => {
        const destructive = isDestructive(c)
        return (
          <li key={i} className="flex items-center gap-3 px-3.5 py-2 bg-panel/60 text-[13px]">
            <span className={`font-mono text-[10px] tracking-wide px-1.5 py-px rounded-sm shrink-0 ${
              destructive ? 'bg-accent/15 text-accent-soft' : 'bg-stone-800 text-stone-400'
            }`}>
              {c.kind}
            </span>
            <span className="text-stone-300">{describeChange(c)}</span>
          </li>
        )
      })}
    </ul>
  )
}

function describeChange(c: Change): string {
  switch (c.kind) {
    case 'create_entity': return `新建表 ${c.entity.name}(${c.entity.dbName}),${c.entity.fields.length} 个字段`
    case 'drop_entity': return `删除表 ${c.name}(${c.dbName})及其全部数据`
    case 'rename_entity': return `表 ${c.from} 改名为 ${c.to}(数据保留)`
    case 'add_field': return `${c.entityDb} 加字段 ${c.field.name}(${c.field.dbName})`
    case 'drop_field': return `${c.entityDb} 删字段 ${c.name}(${c.dbName})及其数据`
    case 'rename_field': return `${c.entityDb}.${c.from} 改名为 ${c.to}(数据保留)`
    case 'change_field_type': return `${c.entityDb}.${c.dbName} 类型 ${c.from} → ${c.to}`
  }
}
