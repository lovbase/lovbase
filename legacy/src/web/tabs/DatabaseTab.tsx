import React from 'react'
import type { IR } from '../../shared/ir'

export function DatabaseTab({ ir }: { ir: IR }) {
  if (ir.entities.length === 0)
    return (
      <div className="h-full flex items-center justify-center text-stone-600 font-mono text-sm">
        还没有表
      </div>
    )
  return (
    <div className="p-8 space-y-6 overflow-auto h-full">
      <div className="flex items-baseline gap-4 flex-wrap">
        <p className="font-mono text-[10px] uppercase tracking-widest text-stone-600">
          real postgres — 可直连
        </p>
        <code className="font-mono text-xs text-stone-400 bg-panel border border-edge rounded px-2.5 py-1 select-all">
          psql postgres://lovbase:lovbase@localhost:5433/lovbase
        </code>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {ir.entities.map((e) => (
          <div key={e.id} className="border border-edge rounded-lg overflow-hidden bg-panel/40">
            <div className="px-4 py-3 border-b border-edge flex items-baseline justify-between gap-2 bg-panel">
              <span className="text-stone-100 font-medium">{e.name}</span>
              <code className="font-mono text-[11px] text-accent-soft">app_main.{e.dbName}</code>
            </div>
            <table className="w-full text-[13px]">
              <tbody className="font-mono">
                <SysRow name="id" type="uuid pk" />
                {e.fields.map((f) => (
                  <tr key={f.id} className="border-b border-edge/60 last:border-0">
                    <td className="px-4 py-2 text-stone-200 text-xs">{f.dbName}</td>
                    <td className="px-4 py-2 text-stone-500 text-xs">
                      {f.type === 'link'
                        ? <>uuid <span className="text-accent-soft">→ {ir.entities.find((x) => x.id === f.linkTo)?.dbName}</span></>
                        : f.type === 'select' ? `text(${f.options?.join('|')})` : sqlType(f.type)}
                    </td>
                    <td className="px-4 py-2 text-right text-stone-600 text-xs font-sans">{f.name}</td>
                  </tr>
                ))}
                <SysRow name="created_at" type="timestamptz" />
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  )
}

function sqlType(t: string): string {
  return { text: 'text', number: 'numeric', boolean: 'boolean', date: 'timestamptz' }[t] ?? t
}

function SysRow({ name, type }: { name: string; type: string }) {
  return (
    <tr className="border-b border-edge/60">
      <td className="px-4 py-2 text-stone-600 text-xs">{name}</td>
      <td className="px-4 py-2 text-stone-700 text-xs" colSpan={2}>{type}</td>
    </tr>
  )
}
