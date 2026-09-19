import { useCallback, useEffect, useMemo, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { dbCommit, dbQuery, dbTables } from '../functions'
import { ResizeHandle, useResizable } from '../lib/use-resizable'

// ── A small Postgres client over the workspace schema: catalog tree, editable grid, SQL console. ──
// Every statement runs as the workspace role, so this can never touch structure or other schemas.

type Column = { name: string; type: string; nullable: boolean; pk: boolean; fkTable: string | null; hasDefault: boolean }
type Table = { name: string; columns: Column[]; rows: number }
type Row = Record<string, unknown>
const PAGE = 100
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`

export function DatabasePane({ projectId, apiToken, refreshKey }: { projectId: string; apiToken: string; refreshKey?: number }) {
  const tablesFn = useServerFn(dbTables)
  const [schema, setSchema] = useState('')
  const [tables, setTables] = useState<Table[] | null>(null)
  const [active, setActive] = useState<string | 'sql'>('')
  const [err, setErr] = useState('')
  const side = useResizable('db-side', 240, 180, 480)

  const loadCatalog = useCallback(async () => {
    try {
      const r = await tablesFn({ data: { projectId } })
      setSchema(r.schema); setTables(r.tables)
      setActive((a) => a || r.tables[0]?.name || 'sql')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [projectId])
  useEffect(() => { loadCatalog() }, [loadCatalog, refreshKey])

  const table = tables?.find((t) => t.name === active)
  return (
    <div className="h-full flex min-w-0 bg-ink text-fg">
      <aside className="shrink-0 border-r border-edge overflow-y-auto py-2 text-[12.5px]" style={{ width: side.width }}>
        <div className="px-3 pb-2 flex items-center gap-2">
          <span className="size-2 rounded-full bg-ok" />
          <span className="font-mono text-[12px] text-db font-medium">postgres</span>
          <span className="font-mono text-[10.5px] text-fg-dim truncate">{schema}</span>
        </div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-fg-dim px-3 pt-1 pb-1">表 {tables?.length ?? ''}</p>
        {tables?.map((t) => (
          <button key={t.name} onClick={() => setActive(t.name)}
            className={`w-full text-left px-3 py-1.5 font-mono flex items-center gap-2 transition-colors cursor-pointer border-l-2 ${
              active === t.name ? 'bg-panel text-fg border-accent' : 'text-fg-mid hover:text-fg hover:bg-panel/60 border-transparent'
            }`}>
            <TableIcon /><span className="truncate">{t.name}</span><span className="ml-auto text-fg-dim text-[11px]">{t.rows}</span>
          </button>
        ))}
        {tables?.length === 0 && <p className="px-3 text-fg-dim">schema 里还没有表</p>}
        <p className="font-mono text-[10px] uppercase tracking-widest text-fg-dim px-3 pt-4 pb-1">工具</p>
        <button onClick={() => setActive('sql')}
          className={`w-full text-left px-3 py-1.5 font-mono transition-colors cursor-pointer border-l-2 ${
            active === 'sql' ? 'bg-panel text-fg border-accent' : 'text-fg-mid hover:text-fg hover:bg-panel/60 border-transparent'
          }`}>
          SQL 控制台
        </button>
        <div className="px-3 pt-4 space-y-1">
          <p className="font-mono text-[10px] uppercase tracking-widest text-fg-dim">api token</p>
          <code className="block font-mono text-[10.5px] text-fg-dim break-all select-all">{apiToken}</code>
        </div>
      </aside>
      <ResizeHandle {...side.handleProps} />
      <div className="flex-1 min-w-0 min-h-0">
        {err && <p className="p-4 text-accent-soft text-sm">{err}</p>}
        {active === 'sql' && <SqlConsole projectId={projectId} onWrote={loadCatalog} />}
        {table && <TableGrid key={table.name} projectId={projectId} table={table} onCommitted={loadCatalog} />}
      </div>
    </div>
  )
}

// ── Editable grid with pending changes, committed as one transaction ──

type Edits = { updated: Map<string, Row>; inserted: Row[]; deleted: Set<string> }
const emptyEdits = (): Edits => ({ updated: new Map(), inserted: [], deleted: new Set() })

function TableGrid({ projectId, table, onCommitted }: { projectId: string; table: Table; onCommitted: () => void }) {
  const query = useServerFn(dbQuery)
  const commit = useServerFn(dbCommit)
  const [where, setWhere] = useState('')
  const [orderBy, setOrderBy] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<Row[]>([])
  const [meta, setMeta] = useState({ ms: 0, sql: '', error: '' })
  const [edits, setEdits] = useState<Edits>(emptyEdits)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const pk = table.columns.find((c) => c.pk)?.name ?? 'id'

  const sql = useMemo(() => {
    const w = where.trim() ? ` WHERE ${where.trim()}` : ''
    const o = orderBy.trim() ? ` ORDER BY ${orderBy.trim()}` : ` ORDER BY ${qi(pk)}`
    return `SELECT * FROM ${qi(table.name)}${w}${o} LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`
  }, [table.name, where, orderBy, page, pk])

  const load = useCallback(async () => {
    setBusy(true)
    const r = await query({ data: { projectId, sql } })
    setRows(r.rows); setMeta({ ms: r.ms, sql, error: r.error ?? '' }); setEdits(emptyEdits()); setSel(new Set())
    setBusy(false)
  }, [projectId, sql])
  useEffect(() => { load() }, [load])

  const dirty = edits.updated.size + edits.inserted.length + edits.deleted.size
  function setCell(rowId: string, col: string, value: unknown) {
    setEdits((e) => { const u = new Map(e.updated); u.set(rowId, { ...u.get(rowId), [col]: value }); return { ...e, updated: u } })
  }
  function setNewCell(i: number, col: string, value: unknown) {
    setEdits((e) => { const ins = e.inserted.slice(); ins[i] = { ...ins[i], [col]: value }; return { ...e, inserted: ins } })
  }

  async function doCommit() {
    const stmts: { sql: string; params: unknown[] }[] = []
    for (const [id, patch] of edits.updated) {
      const cols = Object.keys(patch)
      if (!cols.length) continue
      stmts.push({ sql: `UPDATE ${qi(table.name)} SET ${cols.map((c, i) => `${qi(c)} = $${i + 1}`).join(', ')} WHERE ${qi(pk)} = $${cols.length + 1}`, params: [...cols.map((c) => patch[c]), id] })
    }
    for (const r of edits.inserted) {
      const cols = Object.keys(r).filter((c) => r[c] !== '' && r[c] != null)
      if (!cols.length) continue
      stmts.push({ sql: `INSERT INTO ${qi(table.name)} (${cols.map(qi).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, params: cols.map((c) => r[c]) })
    }
    if (edits.deleted.size) stmts.push({ sql: `DELETE FROM ${qi(table.name)} WHERE ${qi(pk)} = ANY($1)`, params: [[...edits.deleted]] })
    if (!stmts.length) return
    setBusy(true)
    const r = await commit({ data: { projectId, statements: stmts } })
    setBusy(false)
    if (r.error) { setMeta((m) => ({ ...m, error: r.error! })); return }
    await load(); onCommitted()
  }

  const editable = (c: Column) => !c.pk && c.name !== 'created_at'
  return (
    <div className="h-full flex flex-col min-w-0">
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-edge bg-panel/40 font-mono text-[12px]">
        <label className="flex items-center gap-1.5 flex-1 min-w-0"><span className="text-accent-soft">WHERE</span>
          <input value={where} onChange={(e) => { setWhere(e.target.value); setPage(1) }} onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="status = '已签到'" className="flex-1 min-w-0 bg-ink border border-edge rounded px-2 py-1 text-fg placeholder-fg-dim/60 focus:outline-none focus:border-edge-strong" /></label>
        <label className="flex items-center gap-1.5 w-64"><span className="text-accent-soft">ORDER BY</span>
          <input value={orderBy} onChange={(e) => setOrderBy(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="created_at desc" className="flex-1 min-w-0 bg-ink border border-edge rounded px-2 py-1 text-fg placeholder-fg-dim/60 focus:outline-none focus:border-edge-strong" /></label>
        <Btn onClick={load} disabled={busy}>刷新</Btn>
        <Btn onClick={() => setEdits((e) => ({ ...e, inserted: [...e.inserted, {}] }))}>+ 新增行</Btn>
        <Btn onClick={() => { setEdits((e) => ({ ...e, deleted: new Set([...e.deleted, ...sel]) })); setSel(new Set()) }} disabled={sel.size === 0}>删除行{sel.size ? ` (${sel.size})` : ''}</Btn>
        <Btn onClick={doCommit} disabled={!dirty || busy} primary>提交{dirty ? ` (${dirty})` : ''}</Btn>
        <Btn onClick={() => setEdits(emptyEdits())} disabled={!dirty}>回滚</Btn>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <table className="min-w-full text-[12.5px] border-collapse">
          <thead className="sticky top-0 bg-panel z-10">
            <tr>
              <th className="w-8 border-b border-r border-edge px-2 py-1.5 text-fg-dim font-normal">#</th>
              {table.columns.map((c) => (
                <th key={c.name} className="text-left border-b border-r border-edge px-3 py-1.5 font-normal whitespace-nowrap">
                  <div className="flex items-center gap-1.5 text-fg">
                    {c.pk ? <KeyIcon /> : c.fkTable ? <span className="text-accent-soft" title={`→ ${c.fkTable}`}>#</span> : null}
                    <span className="font-medium">{c.name}</span>
                  </div>
                  <div className="font-mono text-[10.5px] text-fg-dim">{c.type}{c.nullable ? '' : ' · not null'}{c.fkTable ? ` · → ${c.fkTable}` : ''}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((r, i) => {
              const id = String(r[pk])
              const del = edits.deleted.has(id)
              const patch = edits.updated.get(id) ?? {}
              return (
                <tr key={id} className={`${del ? 'opacity-40 line-through' : ''} ${sel.has(id) ? 'bg-accent/10' : i % 2 ? 'bg-panel/40' : ''} hover:bg-panel`}>
                  <td onClick={() => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })}
                    className="border-b border-r border-edge px-2 py-1 text-fg-dim text-center cursor-pointer select-none">{(page - 1) * PAGE + i + 1}</td>
                  {table.columns.map((c) => (
                    <Cell key={c.name} value={c.name in patch ? patch[c.name] : r[c.name]} column={c} changed={c.name in patch}
                      editable={editable(c) && !del} onChange={(v) => setCell(id, c.name, v)} />
                  ))}
                </tr>
              )
            })}
            {edits.inserted.map((r, i) => (
              <tr key={`new-${i}`} className="bg-ok/5">
                <td className="border-b border-r border-edge px-2 py-1 text-ok text-center">+</td>
                {table.columns.map((c) => (
                  <Cell key={c.name} value={r[c.name] ?? ''} column={c} changed={false}
                    editable={editable(c)} placeholder={c.pk || c.hasDefault ? 'auto' : c.nullable ? 'null' : '必填'} onChange={(v) => setNewCell(i, c.name, v)} />
                ))}
              </tr>
            ))}
            {rows.length === 0 && edits.inserted.length === 0 && (
              <tr><td colSpan={table.columns.length + 1} className="px-4 py-10 text-center text-fg-dim font-sans">没有数据</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="h-9 shrink-0 flex items-center gap-4 px-3 border-t border-edge bg-panel/40 font-mono text-[11.5px] text-fg-dim">
        <span>共 {rows.length} 行{rows.length === PAGE ? '+' : ''}(表 {table.rows} 行)</span>
        <span>{meta.ms}ms</span>
        <span className="flex-1 truncate text-fg-mid" title={meta.sql}>{meta.error ? <span className="text-accent-soft">{meta.error}</span> : meta.sql}</span>
        <span>{PAGE} 行/页</span>
        <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="disabled:opacity-30 cursor-pointer">‹</button>
        <span className="text-fg">{page}</span>
        <button onClick={() => setPage((p) => p + 1)} disabled={rows.length < PAGE} className="disabled:opacity-30 cursor-pointer">›</button>
      </div>
    </div>
  )
}

function Cell({ value, column, changed, editable, placeholder, onChange }: {
  value: unknown; column: Column; changed: boolean; editable: boolean; placeholder?: string; onChange: (v: unknown) => void
}) {
  const [editing, setEditing] = useState(false)
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  const cls = `border-b border-r border-edge px-3 py-1 whitespace-nowrap max-w-[24rem] truncate ${changed ? 'bg-amber-500/15' : ''} ${editable ? 'cursor-text' : 'text-fg-dim'}`
  if (editing)
    return (
      <td className="border-b border-r border-edge p-0">
        <input autoFocus defaultValue={text}
          onBlur={(e) => { setEditing(false); const v = e.target.value; if (v !== text) onChange(coerce(v, column)) }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false) }}
          className="w-full min-w-[8rem] px-3 py-1 bg-ink text-fg outline-none border border-accent" />
      </td>
    )
  return (
    <td onDoubleClick={() => editable && setEditing(true)} className={cls} title={text}>
      {value == null || value === '' ? <span className="text-fg-dim/60">{placeholder ?? (value === null ? 'null' : '')}</span> : text}
    </td>
  )
}

/** Turn the typed string into something Postgres accepts for the column type. */
function coerce(v: string, c: Column): unknown {
  if (v === '' || v.toLowerCase() === 'null') return null
  if (c.type === 'bool') return v === 'true' || v === 't' || v === '1' || v === '是'
  if (c.type === 'numeric' || c.type === 'int4' || c.type === 'int8' || c.type === 'float8') return Number(v)
  return v
}

// ── SQL console ──

function SqlConsole({ projectId, onWrote }: { projectId: string; onWrote: () => void }) {
  const query = useServerFn(dbQuery)
  const [sql, setSql] = useState('select * from ')
  const [res, setRes] = useState<Awaited<ReturnType<typeof query>> | null>(null)
  const [busy, setBusy] = useState(false)
  async function run() {
    setBusy(true)
    const r = await query({ data: { projectId, sql } })
    setRes(r); setBusy(false)
    if (r.kind === 'write' && !r.error) onWrote()
  }
  return (
    <div className="h-full flex flex-col min-w-0">
      <div className="shrink-0 border-b border-edge">
        <textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={6} spellCheck={false}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run() }}
          className="w-full bg-ink font-mono text-[13px] text-fg p-3 focus:outline-none resize-y" />
        <div className="h-9 flex items-center gap-3 px-3 bg-panel/40 font-mono text-[11.5px] text-fg-dim">
          <Btn onClick={run} disabled={busy} primary>运行 ⌘↵</Btn>
          <span>以 workspace 角色执行,单条 SELECT / INSERT / UPDATE / DELETE,读取最多 1000 行</span>
          {res && <span className="ml-auto">{res.error ? <span className="text-accent-soft">{res.error}</span> : `${res.kind === 'read' ? `${res.rowCount} 行` : `影响 ${res.rowCount} 行`} · ${res.ms}ms`}</span>}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {res && !res.error && res.rows.length > 0 && (
          <table className="min-w-full text-[12.5px] border-collapse font-mono">
            <thead className="sticky top-0 bg-panel"><tr>
              <th className="w-8 border-b border-r border-edge px-2 py-1.5 text-fg-dim font-normal">#</th>
              {res.fields.map((f) => <th key={f} className="text-left border-b border-r border-edge px-3 py-1.5 font-medium text-fg whitespace-nowrap">{f}</th>)}
            </tr></thead>
            <tbody>{res.rows.map((r: any, i: number) => (
              <tr key={i} className={i % 2 ? 'bg-panel/40' : ''}>
                <td className="border-b border-r border-edge px-2 py-1 text-fg-dim text-center">{i + 1}</td>
                {res.fields.map((f) => <td key={f} className="border-b border-r border-edge px-3 py-1 whitespace-nowrap max-w-[24rem] truncate">{r[f] == null ? <span className="text-fg-dim/60">null</span> : String(r[f])}</td>)}
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Btn({ children, onClick, disabled, primary }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`px-2.5 py-1 rounded-md text-[12px] font-sans transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
        primary ? 'bg-accent text-on-accent hover:bg-accent-soft' : 'border border-edge text-fg-mid hover:text-fg hover:border-edge-strong'
      }`}>{children}</button>
  )
}
const TableIcon = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="shrink-0 text-db"><rect x="2" y="3" width="12" height="10" rx="1" /><path d="M2 7h12M6 7v6" /></svg>
const KeyIcon = () => <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-amber-500"><circle cx="6" cy="10" r="3" /><path d="M8.5 7.5 13 3M11 5l1.5 1.5" /></svg>
