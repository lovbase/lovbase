import { useCallback, useEffect, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { useRouter } from '@tanstack/react-router'
import type { SheetInfo, SheetMapping, SheetPreview } from '@lovbase/core/sheets'
import { connectGoogle, confirmSheetImport, disconnectGoogle, getConnections, getProjectConnections, getSheetImports, inspectGoogleSheet, previewGoogleSheet, selectGoogleConnection, updateSheetImport } from '../functions/integrations'
import { useT } from '../lib/i18n'
import { Button } from './ui/button'

const inputStyle = 'w-full rounded-md border border-edge bg-panel px-2 py-1.5 text-sm'
const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e)
const connectionsChanged = 'lovbase:connections-changed'
export type ConnectionState = Awaited<ReturnType<typeof getConnections>> & { selectedId?: string | null }

export function GoogleConnections({ projectId, onSelected, onStateChange, onCreate }: { projectId?: string; onSelected?: (id: string | null) => void; onStateChange?: (state: ConnectionState) => void; onCreate?: () => void }) {
  const t = useT(), router = useRouter()
  const list = useServerFn(getConnections), projectList = useServerFn(getProjectConnections)
  const connect = useServerFn(connectGoogle), disconnect = useServerFn(disconnectGoogle), select = useServerFn(selectGoogleConnection)
  const [state, setState] = useState<ConnectionState | null>(null)
  const [label, setLabel] = useState('Google Sheets'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const refresh = useCallback(async () => {
    const next: ConnectionState = projectId ? await projectList({ data: { projectId } }) : await list()
    setState(next)
    onStateChange?.(next)
    if (projectId) onSelected?.(next.selectedId ?? null)
  }, [projectId, projectList, list, onSelected, onStateChange])
  useEffect(() => { let active = true; void refresh().catch(e => { if (active) setError(errorMessage(e)) }); return () => { active = false } }, [refresh])
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('')
    try {
      await fn(); await refresh()
      window.dispatchEvent(new Event(connectionsChanged))
      await router.invalidate()
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  if (state && !state.enabled) return <output className="block rounded-xl border border-edge p-4 text-sm text-fg-dim">{t('connectors.unavailable', 'Connections are not configured yet. Contact your administrator to enable them.')}</output>
  if (!state && !error) return <output className="block p-4 text-sm text-fg-dim">{t('connectors.loading', 'Loading connections…')}</output>
  return <section className="space-y-3 rounded-xl border border-edge p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-sm font-medium">{t('sheets.connections', 'Google Sheets connections')}</h3>
      {onCreate && <Button onClick={onCreate} disabled={!state?.enabled}>{t('connectors.new', 'New connection')}</Button>}
    </div>
    <p className="text-xs text-fg-dim">{projectId ? t('sheets.scope', 'Choose the connection this project can read. Imported data stays in Lovbase after disconnecting.') : t('sheets.accountScope', 'Connect once, then enable the connection in each project that needs it.')}</p>
    {state?.connections.map(c => <div key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="mr-auto break-all">{c.label} · {t(`connectors.state.${c.state}`, c.state)}</span>
      {projectId && c.state === 'active' && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => {
        await select({ data: { projectId, id: state.selectedId === c.id ? null : c.id } })
      })}>{state.selectedId === c.id ? t('sheets.disable', 'Disable for project') : t('sheets.enable', 'Enable for project')}</Button>}
      {!projectId && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { await disconnect({ data: { id: c.id } }) })}>{t('sheets.disconnect', 'Disconnect')}</Button>}
    </div>)}
    {state?.connections.length === 0 && <p className="py-5 text-sm text-fg-dim">{t('connectors.noAccounts', 'No accounts connected yet. Create a connection to get started.')}</p>}
    <div className="flex flex-wrap gap-2">
      {!onCreate && <>
      <input className={`${inputStyle} flex-1 min-w-32`} aria-label={t('sheets.connectionName', 'Connection name')} value={label} maxLength={100} onChange={e => setLabel(e.target.value)} />
      <Button disabled={busy || !state?.enabled || !label.trim()} onClick={() => run(async () => {
        const result = await connect({ data: { label, projectId } }); window.location.assign(result.url)
      })}>{t('sheets.connect', 'Connect Google')}</Button>
      </>}
      <Button variant="outline" disabled={busy} onClick={() => run(async () => {})}>{t('sheets.refresh', 'Refresh connections')}</Button>
    </div>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </section>
}

export function SheetsWorkspace({ projectId, appId, seed, seedKey, disabled, onQueued }: {
  projectId: string; appId: string; seed?: string; seedKey?: string; disabled: boolean; onQueued: () => void
}) {
  const t = useT()
  const list = useServerFn(getProjectConnections), imports = useServerFn(getSheetImports)
  const inspect = useServerFn(inspectGoogleSheet), prepare = useServerFn(previewGoogleSheet)
  const [enabled, setEnabled] = useState(false), [selectedId, setSelectedId] = useState<string | null>(null)
  const [open, setOpen] = useState(!!seed), [url, setUrl] = useState(seed ?? '')
  const [info, setInfo] = useState<SheetInfo | null>(null), [sheetId, setSheetId] = useState(0)
  const [headerRow, setHeaderRow] = useState(1), [range, setRange] = useState('')
  const [previews, setPreviews] = useState<SheetPreview[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    const next = await imports({ data: { projectId } }); setPreviews(next)
  }, [imports, projectId])
  useEffect(() => {
    let alive = true
    const refreshConnections = () => {
      void list({ data: { projectId } }).then(s => { if (alive) { setEnabled(s.enabled); setSelectedId(s.selectedId) } }).catch(e => { if (alive) setError(errorMessage(e)) })
    }
    refreshConnections()
    window.addEventListener(connectionsChanged, refreshConnections)
    return () => { alive = false; window.removeEventListener(connectionsChanged, refreshConnections) }
  }, [projectId, list])
  useEffect(() => { if (enabled) void refresh().catch(e => setError(errorMessage(e))) }, [enabled, refresh, seedKey])
  useEffect(() => { if (seed) { setUrl(seed); setInfo(null); setOpen(true) } }, [seed, seedKey])
  const pending = previews.some(p => p.job && ['queued', 'starting', 'running', 'waiting_capacity', 'finalizing', 'cancelling'].includes(p.job.status))
  useEffect(() => {
    if (!pending) return
    const id = setInterval(() => { void refresh().catch(e => setError(errorMessage(e))) }, 2500)
    return () => clearInterval(id)
  }, [pending, refresh])
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  if (!enabled) return null
  return <section className="rounded-xl border border-edge bg-panel p-3 space-y-3">
    <button className="flex w-full items-center justify-between text-sm font-medium cursor-pointer" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span>{t('sheets.title', 'Build from Google Sheets')}</span><span aria-hidden="true">{open ? '−' : '+'}</span>
    </button>
    {open && <>
      <GoogleConnections projectId={projectId} onSelected={setSelectedId} />
      <p className="text-xs text-fg-dim">{t('sheets.hint', 'Import one worksheet into a new table. This is a one-time copy; changes will not sync back to Google.')}</p>
      <label className="block space-y-1 text-xs">{t('sheets.link', 'Spreadsheet link')}
        <input className={inputStyle} value={url} onChange={e => { setUrl(e.target.value); setInfo(null) }} placeholder="https://docs.google.com/spreadsheets/d/…/edit" />
      </label>
      <Button variant="outline" disabled={!selectedId || !url.trim() || busy || disabled} onClick={() => run(async () => {
        const result = await inspect({ data: { projectId, url } }); setInfo(result); setSheetId(result.sheets[0]?.id ?? 0)
      })}>{t('sheets.continue', 'Continue · read worksheets')}</Button>
      {info && <div className="space-y-3">
        <p className="text-sm font-medium">{info.title}</p>
        <label className="block space-y-1 text-xs">{t('sheets.worksheet', 'Worksheet')}
          <select className={inputStyle} value={sheetId} onChange={e => setSheetId(Number(e.target.value))}>
            {info.sheets.map(s => <option key={s.id} value={s.id}>{s.title} ({s.rows} × {s.columns})</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1 text-xs">{t('sheets.headerRow', 'Header row')}
            <input className={inputStyle} type="number" min="1" value={headerRow} onChange={e => setHeaderRow(Number(e.target.value))} />
          </label>
          <label className="space-y-1 text-xs">{t('sheets.range', 'Range (optional)')}
            <input className={inputStyle} value={range} placeholder="A1:F500" onChange={e => setRange(e.target.value.toUpperCase())} />
          </label>
        </div>
        <p className="text-xs text-fg-dim">{t('sheets.limits', 'Up to 10,000 data rows and 10 MiB. For a large worksheet, choose a smaller range.')}</p>
        <Button disabled={busy || disabled || !selectedId} onClick={() => run(async () => {
          await prepare({ data: { projectId, appId, source: { url, sheetId, headerRow, range } } }); await refresh()
        })}>{busy ? t('sheets.reading', 'Reading…') : t('sheets.preview', 'Preview import')}</Button>
      </div>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {previews.filter(p => p.appId === appId).map(p => <ImportPreview key={`${p.id}:${p.version}`} preview={p} projectId={projectId} disabled={disabled || busy} onUpdated={refresh} onQueued={onQueued} />)}
    </>}
  </section>
}

function ImportPreview({ preview: p, projectId, disabled, onUpdated, onQueued }: {
  preview: SheetPreview; projectId: string; disabled: boolean; onUpdated: () => Promise<void>; onQueued: () => void
}) {
  const t = useT(), router = useRouter()
  const save = useServerFn(updateSheetImport), confirm = useServerFn(confirmSheetImport)
  const [mapping, setMapping] = useState<SheetMapping>(p.mapping), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const dirty = JSON.stringify(mapping) !== JSON.stringify(p.mapping)
  const editable = p.status === 'preview'
  const failed = !!p.job && ['failed', 'interrupted', 'cancelled'].includes(p.job.status)
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('')
    try { await fn(); await onUpdated(); await router.invalidate() } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <div className="space-y-3 rounded-lg border border-edge p-3">
    <div className="flex flex-wrap justify-between gap-2 text-sm font-medium">
      <span>{p.mapping.tableName} · {p.rowCount} {t('sheets.rows', 'rows')}</span>
      <span>{p.status === 'imported' ? t('sheets.imported', 'Data imported') : p.status === 'queued' ? t('sheets.queued', 'Import confirmed') : t('sheets.awaiting', 'Awaiting confirmation')}</span>
    </div>
    {editable && <>
      <label className="block space-y-1 text-xs">{t('sheets.tableName', 'New table name')}
        <input className={inputStyle} value={mapping.tableName} onChange={e => setMapping({ ...mapping, tableName: e.target.value })} />
      </label>
      <div className="max-h-64 overflow-auto space-y-2">
        {mapping.fields.map((f, i) => <div key={f.column} className="grid grid-cols-[1fr_1fr_90px_auto] gap-2 items-center">
          <span className="truncate text-xs" title={p.headers[f.column]}>{p.headers[f.column]}</span>
          <input className={inputStyle} aria-label={`${t('sheets.fieldName', 'Field name')} ${i + 1}`} value={f.name} onChange={e => setMapping({ ...mapping, fields: mapping.fields.map((v, j) => j === i ? { ...v, name: e.target.value } : v) })} />
          <select className={inputStyle} aria-label={`${t('sheets.fieldType', 'Field type')} ${i + 1}`} value={f.type} onChange={e => setMapping({ ...mapping, fields: mapping.fields.map((v, j) => j === i ? { ...v, type: e.target.value as typeof f.type } : v) })}>
            <option value="text">{t('sheets.text', 'Text')}</option><option value="number">{t('sheets.number', 'Number')}</option><option value="boolean">{t('sheets.boolean', 'Boolean')}</option><option value="date">{t('sheets.date', 'Date')}</option>
          </select>
          <button aria-label={`${t('sheets.omit', 'Omit column')} ${f.name}`} disabled={mapping.fields.length <= 1} className="px-1 disabled:opacity-30" onClick={() => setMapping({ ...mapping, fields: mapping.fields.filter((_, j) => i !== j) })}>×</button>
        </div>)}
      </div>
      <Button variant="outline" disabled={busy || disabled || !dirty} onClick={() => run(async () => {
        await save({ data: { projectId, id: p.id, version: p.version, mapping } })
      })}>{t('sheets.validate', 'Save and validate fields')}</Button>
    </>}
    <details>
      <summary className="cursor-pointer text-xs text-fg-dim">{t('sheets.sample', 'Data sample (first 5 rows; long cells shortened)')}</summary>
      <div className="max-h-48 overflow-auto mt-2"><table className="text-xs border-collapse">
        <thead><tr>{p.mapping.fields.map(f => <th className="border border-edge p-2 text-left whitespace-nowrap" key={f.column}>{f.name}</th>)}</tr></thead>
        <tbody>{p.sample.map((row, i) => <tr key={i}>{p.mapping.fields.map(f => <td className="border border-edge p-2 min-w-24 max-w-60 truncate" key={f.column}>{String(row[f.column] ?? '')}</td>)}</tr>)}</tbody>
      </table></div>
    </details>
    {p.errors.length > 0 && <div role="alert" className="text-xs text-red-600 space-y-1">{p.errors.map((e, i) => <p key={i}>{e}</p>)}</div>}
    {p.job && <p role="status" className="text-xs text-fg-dim">{t('sheets.buildStatus', 'Build status')}: {p.job.status}{p.job.error ? ` · ${p.job.error}` : ''}</p>}
    {(editable || failed) && <Button disabled={busy || disabled || dirty || !!p.errors.length} onClick={() => run(async () => {
      await confirm({ data: { projectId, appId: p.appId, id: p.id, version: p.version } }); onQueued()
    })}>{p.status === 'imported' ? t('sheets.retryBuild', 'Retry interface generation') : failed ? t('sheets.retry', 'Retry confirmed import') : t('sheets.confirm', 'Confirm import and build')}</Button>}
    {p.status === 'imported' && <p className="text-xs text-fg-dim">{t('sheets.saved', 'The data is saved in Database. Retrying the build will not import it again.')}</p>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </div>
}
