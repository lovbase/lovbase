import React, { useState } from 'react'
import type { State } from '../api'

export function CodeTab({ state }: { state: State }) {
  const [view, setView] = useState<'ddl' | 'ir'>('ddl')
  return (
    <div className="h-full flex flex-col p-8 gap-4 max-w-4xl">
      <div className="flex gap-5">
        {(['ddl', 'ir'] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={`relative font-mono text-xs lowercase tracking-wide pb-1 ${
              view === v ? 'text-stone-100' : 'text-stone-500 hover:text-stone-300'
            }`}>
            {v === 'ddl' ? 'schema.sql' : 'ir.json'}
            {view === v && <span className="absolute left-0 right-0 bottom-0 h-[2px] bg-accent" />}
          </button>
        ))}
      </div>
      <pre className="flex-1 overflow-auto bg-panel border border-edge rounded-lg p-5 font-mono text-[12.5px] leading-relaxed text-stone-300">
        {view === 'ddl' ? state.ddl || '-- 还没有表' : JSON.stringify(state.ir, null, 2)}
      </pre>
    </div>
  )
}
