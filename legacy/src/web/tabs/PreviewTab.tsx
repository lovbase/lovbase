import React, { useCallback, useEffect, useState } from 'react'
import { deleteRow, insertRow, listRows } from '../api'
import type { Entity, Field, IR } from '../../shared/ir'

// The shell is the dark workshop; the preview surface is the bright artifact.
export function PreviewTab({ ir }: { ir: IR }) {
  const [entityId, setEntityId] = useState(ir.entities[0]?.id ?? '')
  const entity = ir.entities.find((e) => e.id === entityId) ?? ir.entities[0]

  if (ir.entities.length === 0)
    return (
      <div className="h-full flex items-center justify-center text-stone-600 font-mono text-sm">
        还没有应用 — 去 agents 里描述一个
      </div>
    )

  return (
    <div className="h-full flex">
      <aside className="w-52 border-r border-edge p-3 space-y-0.5 overflow-y-auto shrink-0">
        <p className="font-mono text-[10px] uppercase tracking-widest text-stone-600 px-3 pt-1 pb-2">entities</p>
        {ir.entities.map((e) => (
          <button key={e.id} onClick={() => setEntityId(e.id)}
            className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
              entity?.id === e.id
                ? 'bg-panel text-stone-100 border-l-2 border-accent'
                : 'text-stone-400 hover:text-stone-200 border-l-2 border-transparent'
            }`}>
            {e.name}
          </button>
        ))}
      </aside>
      <div className="flex-1 bg-paper text-stone-900 overflow-auto">
        {entity && <EntityView key={entity.id} entity={entity} ir={ir} />}
      </div>
    </div>
  )
}

function EntityView({ entity, ir }: { entity: Entity; ir: IR }) {
  const [rows, setRows] = useState<any[]>([])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    listRows(entity.id).then(setRows).catch((e) => setError(e.message))
  }, [entity.id])
  useEffect(refresh, [refresh])

  async function add() {
    setError('')
    try {
      await insertRow(entity.id, draft)
      setDraft({}); refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="p-8 max-w-5xl space-y-5">
      <div className="flex items-baseline gap-3">
        <h2 className="text-xl font-semibold tracking-tight">{entity.name}</h2>
        <span className="text-stone-400 text-sm">{rows.length} 条</span>
      </div>
      <div className="flex flex-wrap gap-3 items-end bg-white border border-stone-200 rounded-lg p-4 shadow-sm">
        {entity.fields.map((f) => (
          <label key={f.id} className="text-xs text-stone-500 space-y-1.5">
            <span className="block">{f.name}{f.required && <span className="text-accent"> *</span>}</span>
            <FieldInput field={f} ir={ir} value={draft[f.id] ?? ''}
              onChange={(v) => setDraft((d) => ({ ...d, [f.id]: v }))} />
          </label>
        ))}
        <button onClick={add}
          className="px-4 py-2 bg-stone-900 text-white rounded-md text-sm hover:bg-stone-700 transition-colors">
          添加
        </button>
      </div>
      {error && <p className="text-sm text-accent">{error}</p>}
      <div className="bg-white border border-stone-200 rounded-lg overflow-x-auto shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-200 text-left text-stone-400">
              {entity.fields.map((f) => (
                <th key={f.id} className="px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider font-medium">
                  {f.name}
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50 group">
                {entity.fields.map((f) => (
                  <td key={f.id} className="px-4 py-2.5">{renderCell(row[f.dbName], f)}</td>
                ))}
                <td className="px-2 text-center">
                  <button onClick={() => deleteRow(entity.id, row.id).then(refresh)}
                    className="text-transparent group-hover:text-stone-300 hover:!text-accent transition-colors">×</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={entity.fields.length + 1} className="px-4 py-10 text-center text-stone-400">
                还没有数据 — 用上面的表单加一条
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FieldInput({ field, ir, value, onChange }: {
  field: Field; ir: IR; value: string; onChange: (v: string) => void
}) {
  const cls = 'block px-2.5 py-2 border border-stone-300 rounded-md text-sm text-stone-900 bg-white w-44 focus:outline-none focus:border-stone-500'
  if (field.type === 'select')
    return (
      <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  if (field.type === 'link')
    return <LinkInput field={field} ir={ir} value={value} onChange={onChange} cls={cls} />
  if (field.type === 'boolean')
    return (
      <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option><option value="true">是</option><option value="false">否</option>
      </select>
    )
  const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'datetime-local' : 'text'
  return <input className={cls} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
}

function LinkInput({ field, ir, value, onChange, cls }: {
  field: Field; ir: IR; value: string; onChange: (v: string) => void; cls: string
}) {
  const target = ir.entities.find((e) => e.id === field.linkTo)
  const [options, setOptions] = useState<any[]>([])
  useEffect(() => {
    if (target) listRows(target.id).then(setOptions).catch(() => {})
  }, [target?.id])
  const labelField = target?.fields[0]
  return (
    <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {options.map((r) => (
        <option key={r.id} value={r.id}>{labelField ? r[labelField.dbName] : r.id}</option>
      ))}
    </select>
  )
}

function renderCell(v: unknown, f: Field): React.ReactNode {
  if (v == null || v === '') return <span className="text-stone-300">—</span>
  if (f.type === 'boolean') return v ? '是' : '否'
  if (f.type === 'date') return new Date(v as string).toLocaleString()
  if (f.type === 'link')
    return <span className="font-mono text-xs text-stone-400">{String(v).slice(0, 8)}</span>
  if (f.type === 'select')
    return (
      <span className="inline-block px-2 py-0.5 bg-stone-100 border border-stone-200 rounded-full text-xs">
        {String(v)}
      </span>
    )
  return String(v)
}
