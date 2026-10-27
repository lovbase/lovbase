import { useCallback, useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import type { SheetInfo, SheetMapping, SheetPreview } from '@lovbase/core/sheets'
import { confirmSheetImport, getProjectConnections, getSheetImports, inspectGoogleSheet, previewGoogleSheet, updateSheetImport } from '../functions/integrations'
import { useT } from '../lib/i18n'
import { ConnectorsDialog, connectionsChanged } from './ConnectorsDialog'
import type { AccountView } from '@lovbase/core/connections'
import { Button } from './ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

const inputStyle = 'w-full rounded-md border border-edge bg-panel px-2 py-1.5 text-sm'
const errorMessage = (e: unknown) => e instanceof Error ? e.message : String(e)

export function GoogleConnections({ projectId }: { projectId?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return <><Button variant="outline" onClick={() => setOpen(true)}>{t('connections.manage', 'Manage connected accounts')}</Button><ConnectorsDialog open={open} onOpenChange={setOpen} projectId={projectId} /></>
}

export function SheetsWorkspace({ projectId, appId, seed, seedKey, disabled, onQueued }: {
  projectId: string; appId: string; seed?: string; seedKey?: string; disabled: boolean; onQueued: () => void
}) {
  const t = useT()
  const list = useServerFn(getProjectConnections), imports = useServerFn(getSheetImports)
  const inspect = useServerFn(inspectGoogleSheet), prepare = useServerFn(previewGoogleSheet)
  const [enabled, setEnabled] = useState(false), [selectedId, setSelectedId] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<AccountView[]>([])
  const [defaultId, setDefaultId] = useState<string | null>(null)
  const [url, setUrl] = useState(seed ?? '')
  const [info, setInfo] = useState<SheetInfo | null>(null), [sheetId, setSheetId] = useState(0)
  const [headerRow, setHeaderRow] = useState(1), [range, setRange] = useState('')
  const [previews, setPreviews] = useState<SheetPreview[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    const next = await imports({ data: { projectId } }); setPreviews(next)
  }, [imports, projectId])
  useEffect(() => {
    let alive = true
    const refreshConnections = () => {
      void list({ data: { projectId } }).then(s => {
        if (!alive) return
        const available = s.connections.filter(c => c.toolkit === 'googlesheets' && c.state === 'active' && s.enabledIds.includes(c.id))
        setEnabled(s.enabled); setDefaultId(s.selectedId); setAccounts(available)
        setSelectedId(current => available.some(c => c.id === current) ? current : s.selectedId)
      }).catch(e => { if (alive) setError(errorMessage(e)) })
    }
    refreshConnections()
    window.addEventListener(connectionsChanged, refreshConnections)
    return () => { alive = false; window.removeEventListener(connectionsChanged, refreshConnections) }
  }, [projectId, list])
  useEffect(() => { if (enabled) void refresh().catch(e => setError(errorMessage(e))) }, [enabled, refresh, seedKey])
  useEffect(() => { if (seed) { setUrl(seed); setInfo(null) } }, [seed, seedKey])
  const pending = previews.some(p => p.job && ['queued', 'starting', 'running', 'waiting_capacity', 'finalizing', 'cancelling'].includes(p.job.status))
  useEffect(() => {
    if (!pending) return
    const id = setInterval(() => { void refresh().catch(e => setError(errorMessage(e))) }, 2500)
    return () => clearInterval(id)
  }, [pending, refresh])
  // A refresh can revoke the selected account while worksheet metadata is still visible.
  const currentInfo = info?.connection?.id === selectedId ? info : null
  const accountLabel = (account: AccountView) => `${account.identity || account.label || account.appName}${account.id === defaultId ? ` · ${t('connections.default', 'Default account')}` : ''}`
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  // Import controls belong to an active import, rather than a permanent chat launcher.
  if (!enabled || (!seed && !previews.some(p => p.appId === appId))) return null
  return <section className="rounded-xl border border-edge bg-panel p-3 space-y-3">
      <GoogleConnections projectId={projectId} />
      <label className="block space-y-1 text-xs">{t('connections.usedAccount', 'Account for this import')}
        <Select value={selectedId ?? ''} disabled={busy || disabled} onValueChange={value => { setSelectedId(value || null); setInfo(null) }}>
          <SelectTrigger aria-label={t('connections.usedAccount', 'Account for this import')} className={inputStyle}>
            <SelectValue>{value => {
              const account = accounts.find(account => account.id === value)
              return account ? accountLabel(account) : t('connections.chooseAccount', 'Choose an account')
            }}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{t('connections.chooseAccount', 'Choose an account')}</SelectItem>
            {accounts.map(account => <SelectItem key={account.id} value={account.id}>{accountLabel(account)}</SelectItem>)}
          </SelectContent>
        </Select>
      </label>
      <p className="text-xs text-fg-dim">{t('sheets.hint', 'Import one worksheet into a new table. This is a one-time copy; changes will not sync back to Google.')}</p>
      <label className="block space-y-1 text-xs">{t('sheets.link', 'Spreadsheet link')}
        <input className={inputStyle} value={url} onChange={e => { setUrl(e.target.value); setInfo(null) }} placeholder="https://docs.google.com/spreadsheets/d/…/edit" />
      </label>
      <Button variant="outline" disabled={!selectedId || !url.trim() || busy || disabled} onClick={() => run(async () => {
        const result = await inspect({ data: { projectId, url, connectionId: selectedId ?? undefined } }); setInfo(result); setSheetId(result.sheets[0]?.id ?? 0)
      })}>{t('sheets.continue', 'Continue · read worksheets')}</Button>
      {currentInfo && <div className="space-y-3">
        <p className="text-sm font-medium">{currentInfo.title}</p>
        {currentInfo.connection && <p className="break-all text-xs text-fg-dim">{t('connections.using', 'Using account: {account}').replace('{account}', currentInfo.connection.label)}</p>}
        <label className="block space-y-1 text-xs">{t('sheets.worksheet', 'Worksheet')}
          <Select value={sheetId} onValueChange={value => { if (value !== null) setSheetId(value) }}>
            <SelectTrigger aria-label={t('sheets.worksheet', 'Worksheet')} className={inputStyle}>
              <SelectValue>{value => {
                const sheet = currentInfo.sheets.find(sheet => sheet.id === value)
                return sheet ? `${sheet.title} (${sheet.rows} × ${sheet.columns})` : ''
              }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {currentInfo.sheets.map(sheet => <SelectItem key={sheet.id} value={sheet.id}>{sheet.title} ({sheet.rows} × {sheet.columns})</SelectItem>)}
            </SelectContent>
          </Select>
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
          await prepare({ data: { projectId, appId, source: { url, sheetId, headerRow, range, connectionId: selectedId ?? undefined } } }); await refresh()
        })}>{busy ? t('sheets.reading', 'Reading…') : t('sheets.preview', 'Preview import')}</Button>
      </div>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {previews.filter(p => p.appId === appId).map(p => <ImportPreview key={`${p.id}:${p.version}`} preview={p} projectId={projectId} disabled={disabled || busy} onUpdated={refresh} onQueued={onQueued} />)}
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
    {p.connection && <p className="break-all text-xs text-fg-dim">{t('connections.using', 'Using account: {account}').replace('{account}', p.connection.label)}</p>}
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
          <Select value={f.type} onValueChange={value => {
            if (value !== null) setMapping({ ...mapping, fields: mapping.fields.map((field, index) => index === i ? { ...field, type: value } : field) })
          }}>
            <SelectTrigger className={inputStyle} aria-label={`${t('sheets.fieldType', 'Field type')} ${i + 1}`}>
              <SelectValue>{value => value === 'text' ? t('sheets.text', 'Text') : value === 'number' ? t('sheets.number', 'Number') : value === 'boolean' ? t('sheets.boolean', 'Boolean') : t('sheets.date', 'Date')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">{t('sheets.text', 'Text')}</SelectItem>
              <SelectItem value="number">{t('sheets.number', 'Number')}</SelectItem>
              <SelectItem value="boolean">{t('sheets.boolean', 'Boolean')}</SelectItem>
              <SelectItem value="date">{t('sheets.date', 'Date')}</SelectItem>
            </SelectContent>
          </Select>
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
