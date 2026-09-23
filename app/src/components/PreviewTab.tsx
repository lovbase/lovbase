import { useCallback, useEffect, useState } from 'react'
import type { Entity, Field, IR } from '@lovbase/core/ir'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useT } from '../lib/i18n'

/** Data access is injected so the same view serves the owner (full) and a share link (read + add). */
export type RowApi = {
  list: (entityId: string) => Promise<any[]>
  insert: (entityId: string, values: Record<string, string>) => Promise<unknown>
  remove?: (entityId: string, rowId: string) => Promise<unknown>
}

export function PreviewTab({ ir, api }: { ir: IR; api: RowApi }) {
  const t = useT()
  const [entityId, setEntityId] = useState(ir.entities[0]?.id ?? '')
  const entity = ir.entities.find((e) => e.id === entityId) ?? ir.entities[0]

  if (ir.entities.length === 0)
    return (
      <div className="h-full flex items-center justify-center text-fg-dim font-mono text-sm">
        {t('preview.noApp', 'No app yet — describe one in the chat')}
      </div>
    )

  return (
    <div className="h-full flex">
      <aside className="w-52 border-r border-edge p-3 space-y-0.5 overflow-y-auto shrink-0">
        <p className="font-mono text-[10px] uppercase tracking-widest text-fg-dim px-3 pt-1 pb-2">entities</p>
        {ir.entities.map((e) => (
          <button key={e.id} onClick={() => setEntityId(e.id)}
            className={`w-full text-left px-3 py-2 rounded text-sm transition-colors cursor-pointer ${
              entity?.id === e.id
                ? 'bg-panel text-fg border-l-2 border-accent'
                : 'text-fg-dim hover:text-fg-mid border-l-2 border-transparent'
            }`}>
            {e.name}
          </button>
        ))}
      </aside>
      <div className="flex-1 bg-paper text-stone-900 overflow-auto">
        {entity && <EntityView key={entity.id} entity={entity} ir={ir} api={api} />}
      </div>
    </div>
  )
}

function EntityView({ entity, ir, api }: { entity: Entity; ir: IR; api: RowApi }) {
  const t = useT()
  const [rows, setRows] = useState<any[]>([])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    api.list(entity.id).then(setRows).catch((e) => setError(e.message))
  }, [entity.id, api])
  useEffect(refresh, [refresh])

  async function add() {
    setError('')
    try {
      await api.insert(entity.id, draft)
      setDraft({}); refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="p-8 max-w-5xl space-y-5">
      <div className="flex items-baseline gap-3">
        <h2 className="text-xl font-semibold tracking-tight">{entity.name}</h2>
        <span className="text-stone-400 text-sm">{t('preview.records', '{n} records').replace('{n}', String(rows.length))}</span>
      </div>
      <div className="flex flex-wrap gap-3 items-end bg-white border border-stone-200 rounded-lg p-4 shadow-sm">
        {entity.fields.map((f) => (
          <label key={f.id} className="text-xs text-stone-500 space-y-1.5">
            <span className="block">{f.name}{f.required && <span className="text-accent"> *</span>}</span>
            <FieldInput field={f} ir={ir} api={api} value={draft[f.id] ?? ''}
              onChange={(v) => setDraft((d) => ({ ...d, [f.id]: v }))} />
          </label>
        ))}
        <button onClick={add}
          className="px-4 py-2 bg-stone-900 text-white rounded-md text-sm hover:bg-stone-700 transition-colors cursor-pointer">
          {t('preview.add', 'Add')}
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
              {api.remove && <th className="w-10" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50 group">
                {entity.fields.map((f) => (
                  <td key={f.id} className="px-4 py-2.5">{renderCell(t, row[f.dbName], f)}</td>
                ))}
                {api.remove && (
                  <td className="px-2 text-center">
                    <button onClick={() => api.remove!(entity.id, row.id).then(refresh)}
                      className="text-transparent group-hover:text-stone-300 hover:!text-accent transition-colors cursor-pointer">×</button>
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={entity.fields.length + 1} className="px-4 py-10 text-center text-stone-400">
                {t('preview.noRows', 'No data yet — add a row with the form above')}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FieldInput({ field, ir, api, value, onChange }: {
  field: Field; ir: IR; api: RowApi; value: string; onChange: (v: string) => void
}) {
  const t = useT()
  const cls = 'block px-2.5 py-2 border border-stone-300 rounded-md text-sm text-stone-900 bg-white w-44 focus:outline-none focus:border-stone-500'
  if (field.type === 'select')
    return (
      <Picker value={value} onChange={onChange} cls={cls}
        options={(field.options ?? []).map((o) => ({ value: o, label: o }))} />
    )
  if (field.type === 'link')
    return <LinkInput field={field} ir={ir} api={api} value={value} onChange={onChange} cls={cls} />
  if (field.type === 'boolean')
    return (
      <Picker value={value} onChange={onChange} cls={cls}
        options={[{ value: 'true', label: t('preview.yes', 'Yes') }, { value: 'false', label: t('preview.no', 'No') }]} />
    )
  const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'datetime-local' : 'text'
  return <input className={cls} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
}

function LinkInput({ field, ir, api, value, onChange, cls }: {
  field: Field; ir: IR; api: RowApi; value: string; onChange: (v: string) => void; cls: string
}) {
  const target = ir.entities.find((e) => e.id === field.linkTo)
  const [options, setOptions] = useState<any[]>([])
  useEffect(() => {
    if (target) api.list(target.id).then(setOptions).catch(() => {})
  }, [target?.id, api])
  const labelField = target?.fields[0]
  return (
    <Picker value={value} onChange={onChange} cls={cls}
      options={options.map((r) => ({ value: r.id, label: String(labelField ? r[labelField.dbName] : r.id) }))} />
  )
}

/**
 * The one control the table could not draw itself. A native `<select>` opens the operating
 * system's list — a different font, a different palette, and on this light canvas a menu that
 * belongs to nothing else on the page — so it is the library's Select, dressed to match the
 * inputs beside it rather than the surrounding chrome.
 */
function Picker({ value, onChange, options, cls }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; cls: string
}) {
  const label = (v: string) => options.find((o) => o.value === v)?.label ?? '—'
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? '')}>
      <SelectTrigger className={`${cls} flex dark:bg-white dark:hover:bg-white`}>
        <SelectValue>{(v: string) => label(v)}</SelectValue>
      </SelectTrigger>
      <SelectContent className="bg-white text-stone-900 ring-black/10">
        <SelectItem value="" className="focus:bg-stone-100 focus:text-stone-900">—</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="focus:bg-stone-100 focus:text-stone-900">{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function renderCell(t: ReturnType<typeof useT>, v: unknown, f: Field): React.ReactNode {
  if (v == null || v === '') return <span className="text-stone-300">—</span>
  if (f.type === 'boolean') return v ? t('preview.yes', 'Yes') : t('preview.no', 'No')
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
