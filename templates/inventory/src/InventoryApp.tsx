import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import {
  ArrowDownUp,
  BarChart3,
  Box,
  Building2,
  ChevronRight,
  ClipboardList,
  Download,
  LayoutDashboard,
  MapPin,
  Package,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Truck,
  X,
} from 'lucide-react'
import {
  csvString,
  displayName,
  parseCsv,
  quantity,
  stockStatus,
  suggestion,
  type InventoryClient,
  type InventoryData,
  type Locale,
  type Row,
} from '@lovbase/core/inventory'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { translate } from './labels'
import './inventory.css'

type Page =
  'dashboard' | 'products' | 'movements' | 'locations' | 'suppliers' | 'orders' | 'analytics' | 'insights'
type Form = {
  type: 'products' | 'suppliers' | 'locations' | 'movement' | 'order' | 'receive' | 'import'
  row?: Row
  productId?: string
}
const navigation: [Page, typeof Box][] = [
  ['dashboard', LayoutDashboard],
  ['products', Package],
  ['movements', ArrowDownUp],
  ['locations', MapPin],
  ['suppliers', Truck],
  ['orders', ClipboardList],
  ['analytics', BarChart3],
  ['insights', Sparkles],
]
const active = (rows: Row[]) => rows.filter((r) => !r.archived)

export function InventoryApp({
  client,
  initialLocale = 'en',
  locale: controlledLocale,
  onLocaleChange,
  initialData,
}: {
  client: InventoryClient
  initialLocale?: Locale
  locale?: Locale
  onLocaleChange?: (locale: Locale) => void
  initialData?: InventoryData
}) {
  const [localLocale, setLocalLocale] = useState<Locale>(initialLocale)
  const locale = controlledLocale ?? localLocale
  const t = (key: string) => translate(locale, key)
  const [data, setData] = useState<InventoryData | null>(initialData ?? null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(!initialData)
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState<Page>('dashboard')
  const [form, setForm] = useState<Form | null>(null)
  const [detail, setDetail] = useState<{
    type: 'products' | 'suppliers' | 'orders'
    row: Row
  } | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [supplier, setSupplier] = useState('')
  const [location, setLocation] = useState('')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [days, setDays] = useState(30)
  const [pageIndex, setPageIndex] = useState(0)
  const pending = useRef<{ key: string; id: string } | null>(null)
  const read = useCallback(async () => {
    setLoading(true)
    try {
      setData(await client.read())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'generic_error')
    } finally {
      setLoading(false)
    }
  }, [client])
  useEffect(() => {
    if (!initialData) void read()
  }, [read, initialData])
  useEffect(() => {
    if (controlledLocale) return
    try {
      const saved = localStorage.getItem('inventory.locale')
      if (saved === 'zh' || saved === 'en') setLocalLocale(saved)
    } catch {}
  }, [controlledLocale])
  function switchLocale(next: Locale) {
    setLocalLocale(next)
    onLocaleChange?.(next)
    if (!controlledLocale)
      try {
        localStorage.setItem('inventory.locale', next)
      } catch {}
  }
  function go(next: Page) {
    setPage(next)
    setQuery('')
    setCategory('')
    setSupplier('')
    setLocation('')
    setStatus('')
    setFrom('')
    setTo('')
    setPageIndex(0)
  }
  async function execute(command: Record<string, unknown>) {
    if (busy || data?.readOnly) return
    setBusy(true)
    setError('')
    const key = JSON.stringify(command)
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() }
    try {
      await client.command({
        ...command,
        action: String(command.action),
        requestId: pending.current.id,
      })
      setData(await client.read())
      pending.current = null
      setForm(null)
      setDetail(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'generic_error')
    } finally {
      setBusy(false)
    }
  }
  const name = (row: Row | undefined) => displayName(row, locale)
  const find = (type: 'products' | 'suppliers' | 'locations' | 'categories', id: unknown) =>
    data?.[type].find((r) => r.id === id)
  const num = (n: unknown) =>
    Number(n || 0).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
      maximumFractionDigits: 2,
    })
  const money = (n: unknown) =>
    new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
      style: 'currency',
      currency: 'CNY',
      maximumFractionDigits: 2,
    }).format(Number(n || 0))
  const date = (value: unknown) =>
    value ? new Date(String(value)).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US') : '—'
  const products = data ? active(data.products) : []
  const counts = data ? { in: 0, low: 0, out: 0 } : null
  if (data && counts)
    for (const product of products)
      counts[stockStatus(quantity(data, product.id), Number(product.reorder_point))]++
  const filtered = useMemo(() => {
    if (!data) return []
    const source =
      page === 'products'
        ? data.products
        : page === 'suppliers'
          ? data.suppliers
          : page === 'movements'
            ? data.movements
            : page === 'orders'
              ? data.orders
              : []
    return source.filter((row) => {
      if (
        query &&
        !`${row.name ?? ''} ${row.name_en ?? ''} ${row.sku ?? ''} ${row.number ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase())
      )
        return false
      if (page === 'products') {
        if (status === 'archived' ? !row.archived : row.archived) return false
        if (category && row.category_id !== category) return false
        if (supplier && row.supplier_id !== supplier) return false
        if (location && !data.balances.some((b) => b.product_id === row.id && b.location_id === location))
          return false
        if (
          ['in', 'low', 'out'].includes(status) &&
          stockStatus(quantity(data, row.id, location), Number(row.reorder_point)) !== status
        )
          return false
      }
      if (page === 'suppliers' && (status === 'archived' ? !row.archived : row.archived)) return false
      if (
        page === 'orders' &&
        ((status && row.status !== status) || (supplier && row.supplier_id !== supplier))
      )
        return false
      if (
        page === 'movements' &&
        ((status && row.kind !== status) || (category && row.product_id !== category))
      )
        return false
      if (
        (page === 'orders' || page === 'movements') &&
        ((from && String(row.created_at) < from) || (to && String(row.created_at).slice(0, 10) > to))
      )
        return false
      return true
    })
  }, [data, page, query, status, category, supplier, location, from, to])
  useEffect(() => setPageIndex(0), [query, status, category, supplier, location, from, to])
  function exportRows(rows: unknown[][], filename: string) {
    const url = URL.createObjectURL(new Blob([csvString(rows)], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }
  function exportCurrent() {
    if (page === 'products')
      exportRows(
        [
          [
            'name',
            'name_en',
            'sku',
            'cost',
            'price',
            'reorder_point',
            'reorder_quantity',
            'unit',
            'description',
          ],
          ...filtered.map((p) => [
            p.name,
            p.name_en,
            p.sku,
            p.cost,
            p.price,
            p.reorder_point,
            p.reorder_quantity,
            p.unit,
            p.description,
          ]),
        ],
        'products.csv',
      )
    if (page === 'suppliers')
      exportRows(
        [
          [t('name'), t('contact'), t('email'), t('phone'), t('lead_days')],
          ...filtered.map((r) => [name(r), r.contact, r.email, r.phone, r.lead_days]),
        ],
        'suppliers.csv',
      )
    if (page === 'movements')
      exportRows(
        [
          [t('date'), t('product'), t('kind'), t('quantity'), t('location'), t('note')],
          ...filtered.map((r) => [
            date(r.created_at),
            name(find('products', r.product_id)),
            t(String(r.kind)),
            r.quantity,
            name(find('locations', r.location_id)),
            r.note,
          ]),
        ],
        'movements.csv',
      )
  }
  const badge = (status: string) => (
    <span className={`inv-badge inv-${status}`}>
      {t(status === 'received' && page === 'orders' ? 'received_order' : status)}
    </span>
  )
  const selector = (label: string, value: string, set: (s: string) => void, rows: Row[]) => (
    <label className="inv-filter">
      <span>{t(label)}</span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null) set(next)
        }}
      >
        <SelectTrigger aria-label={t(label)}>
          <SelectValue>
            {(next) => {
              const row = rows.find((row) => row.id === next)
              return row ? name(row) : t('all')
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="inv-select-popup" positionerClassName="inv-select-positioner">
          <SelectItem value="">{t('all')}</SelectItem>
          {rows.map((row) => (
            <SelectItem key={row.id} value={row.id}>
              {name(row)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
  const statusFilter = (values: string[]) => (
    <label className="inv-filter">
      <span>{t('status')}</span>
      <Select
        value={status}
        onValueChange={(next) => {
          if (next !== null) setStatus(next)
        }}
      >
        <SelectTrigger aria-label={t('status')}>
          <SelectValue>
            {(next) =>
              next ? t(next === 'received' && page === 'orders' ? 'received_order' : String(next)) : t('all')
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="inv-select-popup" positionerClassName="inv-select-positioner">
          <SelectItem value="">{t('all')}</SelectItem>
          {values.map((value) => (
            <SelectItem key={value} value={value}>
              {t(value === 'received' && page === 'orders' ? 'received_order' : value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
  const action = (label: string, type: Form['type']) =>
    !data?.readOnly && (
      <button className="inv-primary" onClick={() => setForm({ type })}>
        <Plus size={16} />
        {t(label)}
      </button>
    )
  const table = (headers: string[], rows: ReactNode[][]) => (
    <div className="inv-table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j}>{v}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={headers.length} className="inv-empty">
                {t('empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
  const paged = filtered.slice(pageIndex * 12, (pageIndex + 1) * 12)
  const metrics = data && counts && (
    <div className="inv-metrics">
      {[
        ['totalSku', products.length],
        ['in', counts.in],
        ['low', counts.low],
        ['out', counts.out],
      ].map(([k, v]) => (
        <div className={`inv-metric inv-${k}`} key={k}>
          <span>{t(String(k))}</span>
          <strong>{num(v)}</strong>
          <Package size={22} />
        </div>
      ))}
    </div>
  )
  const stockRows = (rows: Row[]) =>
    rows.map((p) => [
      <button key="name" className="inv-link" onClick={() => setDetail({ type: 'products', row: p })}>
        {name(p)}
      </button>,
      <code key="sku">{p.sku}</code>,
      badge(stockStatus(quantity(data!, p.id), Number(p.reorder_point))),
      num(quantity(data!, p.id)),
    ])
  return (
    <div className="inventory-app" lang={locale === 'zh' ? 'zh-CN' : 'en'}>
      <aside className="inv-sidebar">
        <div className="inv-brand">
          <Box size={26} />
          <span>
            Stockroom<span className="inv-brand-dot">.</span>
          </span>
        </div>
        <nav>
          {navigation.map(([id, Icon], i) => (
            <div key={id}>
              {[0, 4, 6].includes(i) && (
                <p className="inv-nav-label">
                  {t(i === 0 ? 'operations' : i === 4 ? 'procurement' : 'intelligence')}
                </p>
              )}
              <button className={page === id ? 'selected' : ''} onClick={() => go(id)}>
                <Icon size={18} />
                {t(id)}
                {page === id && <ChevronRight size={15} />}
              </button>
            </div>
          ))}
        </nav>
        <div className="inv-sidebar-note">
          <Building2 size={18} />
          <span>{t('subtitle')}</span>
        </div>
      </aside>
      <div className="inv-body">
        <header className="inv-topbar">
          <div className="inv-breadcrumb">
            Stockroom <ChevronRight size={14} />
            <span>{t(page)}</span>
          </div>
          <div className="inv-toolbar">
            <div className="inv-language" aria-label={t('language')}>
              {(['zh', 'en'] as const).map((l) => (
                <button key={l} aria-pressed={locale === l} onClick={() => switchLocale(l)}>
                  {l === 'zh' ? '中文' : 'EN'}
                </button>
              ))}
            </div>
            <button
              aria-label={t('refresh')}
              title={t('refresh')}
              disabled={loading}
              onClick={() => void read()}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </header>
        {data?.readOnly && (
          <div className="inv-demo">
            <span className="inv-dot" />
            {t('readonly')}
          </div>
        )}
        <main className="inv-main">
          <div className="inv-title">
            <div>
              <p className="inv-eyebrow">
                STOCKROOM / {String(navigation.findIndex(([id]) => id === page) + 1).padStart(2, '0')}
              </p>
              <h1>{t(page)}</h1>
              <p>
                {page === 'dashboard'
                  ? t('welcome')
                  : page === 'insights'
                    ? t('suggestionHelp')
                    : t('subtitle')}
              </p>
            </div>
            <div className="inv-toolbar">
              {['products', 'suppliers', 'movements'].includes(page) && (
                <button onClick={exportCurrent}>
                  <Download size={16} />
                  {t('export')}
                </button>
              )}
              {page === 'products' && !data?.readOnly && (
                <button onClick={() => setForm({ type: 'import' })}>{t('import')}</button>
              )}
              {page === 'products' && action('add', 'products')}
              {page === 'suppliers' && action('add', 'suppliers')}
              {page === 'locations' && action('add', 'locations')}
              {page === 'movements' && action('logMovement', 'movement')}
              {page === 'orders' && action('newOrder', 'order')}
            </div>
          </div>
          {error && (
            <div className="inv-error" role="alert">
              {t(error) === error && !['invalid_input', 'read_only'].includes(error)
                ? t('generic_error')
                : t(error)}{' '}
              <button onClick={() => void read()}>{t('retry')}</button>
            </div>
          )}
          {loading && !data ? (
            <div className="inv-loading" role="status">
              {t('loading')}
            </div>
          ) : (
            data && (
              <>
                {page === 'dashboard' && (
                  <>
                    {metrics}
                    <div className="inv-dashboard-grid">
                      <section className="inv-card">
                        <div className="inv-card-title">
                          <h2>{t('attention')}</h2>
                          <button
                            className="inv-link"
                            onClick={() => {
                              go('products')
                              setStatus('low')
                            }}
                          >
                            {t('viewAll')} →
                          </button>
                        </div>
                        {table(
                          [t('product'), t('sku'), t('status'), t('stock')],
                          stockRows(
                            products
                              .filter((p) => quantity(data, p.id) <= Number(p.reorder_point))
                              .slice(0, 7),
                          ),
                        )}
                      </section>
                      <section className="inv-card">
                        <div className="inv-card-title">
                          <h2>{t('recent')}</h2>
                          <button className="inv-link" onClick={() => go('movements')}>
                            {t('viewAll')} →
                          </button>
                        </div>
                        <div className="inv-activity">
                          {data.movements.slice(0, 7).map((m) => (
                            <div key={m.id}>
                              <span className="inv-activity-icon">
                                <ArrowDownUp size={16} />
                              </span>
                              <div>
                                <strong>{name(find('products', m.product_id))}</strong>
                                <small>
                                  {t(String(m.kind))} · {date(m.created_at)}
                                </small>
                              </div>
                              <b className={m.kind === 'shipped' ? 'inv-negative' : 'inv-positive'}>
                                {m.kind === 'shipped' ? '−' : '+'}
                                {num(m.quantity)}
                              </b>
                            </div>
                          ))}
                        </div>
                      </section>
                    </div>
                    <div className="inv-bottom-cards">
                      <section className="inv-card inv-total">
                        <span>{t('value')}</span>
                        <strong>
                          {money(products.reduce((s, p) => s + Number(p.cost) * quantity(data, p.id), 0))}
                        </strong>
                      </section>
                      <button className="inv-card inv-total" onClick={() => go('orders')}>
                        <span>{t('pending')}</span>
                        <strong>
                          {
                            data.orders.filter((o) => ['submitted', 'partial'].includes(String(o.status)))
                              .length
                          }{' '}
                          <ChevronRight size={24} />
                        </strong>
                      </button>
                      <button className="inv-card inv-total" onClick={() => go('insights')}>
                        <span>{t('suggested')}</span>
                        <strong>
                          {products.filter((p) => suggestion(data, p).needed > 0).length}{' '}
                          <Sparkles size={24} />
                        </strong>
                      </button>
                    </div>
                  </>
                )}
                {['products', 'suppliers', 'movements', 'orders'].includes(page) && (
                  <section className="inv-card">
                    <div className="inv-filters">
                      {['products', 'suppliers', 'orders'].includes(page) && (
                        <label className="inv-search">
                          <Search size={16} />
                          <input
                            aria-label={t('search')}
                            placeholder={t(page === 'suppliers' ? 'searchSuppliers' : 'search')}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                          />
                        </label>
                      )}
                      {page === 'products' && (
                        <>
                          {selector('category', category, setCategory, data.categories)}
                          {selector('supplier', supplier, setSupplier, active(data.suppliers))}
                          {selector('location', location, setLocation, active(data.locations))}
                          {statusFilter(['in', 'low', 'out', 'archived'])}
                        </>
                      )}
                      {page === 'suppliers' && statusFilter(['active', 'archived'])}
                      {page === 'movements' && (
                        <>
                          {selector('product', category, setCategory, data.products)}
                          {statusFilter(['received', 'shipped', 'adjusted', 'transferred'])}
                        </>
                      )}
                      {page === 'orders' && (
                        <>
                          {selector('supplier', supplier, setSupplier, data.suppliers)}
                          {statusFilter(['draft', 'submitted', 'partial', 'received', 'cancelled'])}
                        </>
                      )}
                      {['orders', 'movements'].includes(page) && (
                        <>
                          {[
                            ['from', from, setFrom],
                            ['to', to, setTo],
                          ].map(([key, value, set]) => (
                            <label className="inv-filter" key={String(key)}>
                              <span>{t(String(key))}</span>
                              <input
                                type="date"
                                value={String(value)}
                                onChange={(e) => (set as (s: string) => void)(e.target.value)}
                              />
                            </label>
                          ))}
                        </>
                      )}
                    </div>
                    {page === 'products' &&
                      table(
                        [
                          t('name'),
                          t('sku'),
                          t('category'),
                          t('stock'),
                          t('status'),
                          t('supplier'),
                          t('cost'),
                        ],
                        paged.map((p) => [
                          <button
                            key="name"
                            className="inv-product-name"
                            onClick={() => setDetail({ type: 'products', row: p })}
                          >
                            <span className="inv-product-icon">
                              <Package size={18} />
                            </span>
                            {name(p)}
                          </button>,
                          <code key="sku">{p.sku}</code>,
                          name(find('categories', p.category_id)),
                          num(quantity(data, p.id, location)),
                          badge(
                            p.archived
                              ? 'archived'
                              : stockStatus(quantity(data, p.id, location), Number(p.reorder_point)),
                          ),
                          name(find('suppliers', p.supplier_id)),
                          money(p.cost),
                        ]),
                      )}
                    {page === 'suppliers' &&
                      table(
                        [t('name'), t('contact'), t('email'), t('phone'), t('lead_days'), t('products')],
                        paged.map((s) => [
                          <button
                            key="name"
                            className="inv-link"
                            onClick={() => setDetail({ type: 'suppliers', row: s })}
                          >
                            {name(s)}
                          </button>,
                          s.contact,
                          s.email,
                          s.phone,
                          num(s.lead_days),
                          data.products.filter((p) => p.supplier_id === s.id).length,
                        ]),
                      )}
                    {page === 'movements' &&
                      table(
                        [
                          t('kind'),
                          t('product'),
                          t('quantity'),
                          t('location'),
                          t('destination'),
                          t('date'),
                          t('note'),
                        ],
                        paged.map((m) => [
                          badge(String(m.kind)),
                          name(find('products', m.product_id)),
                          num(m.quantity),
                          name(find('locations', m.location_id)),
                          name(find('locations', m.destination_id)),
                          date(m.created_at),
                          m.note,
                        ]),
                      )}
                    {page === 'orders' &&
                      table(
                        [t('number'), t('supplier'), t('status'), t('total'), t('expected')],
                        paged.map((o) => [
                          <button
                            key="number"
                            className="inv-link"
                            onClick={() => setDetail({ type: 'orders', row: o })}
                          >
                            {o.number}
                          </button>,
                          name(find('suppliers', o.supplier_id)),
                          badge(String(o.status)),
                          money(
                            data.order_items
                              .filter((i) => i.order_id === o.id)
                              .reduce((s, i) => s + Number(i.cost) * Number(i.quantity), 0),
                          ),
                          date(o.expected_at),
                        ]),
                      )}
                    <div className="inv-pagination">
                      <span>
                        {filtered.length
                          ? `${pageIndex * 12 + 1}–${Math.min((pageIndex + 1) * 12, filtered.length)}`
                          : '0'}{' '}
                        / {filtered.length}
                      </span>
                      <div>
                        <button disabled={!pageIndex} onClick={() => setPageIndex((n) => n - 1)}>
                          {t('previous')}
                        </button>
                        <button
                          disabled={(pageIndex + 1) * 12 >= filtered.length}
                          onClick={() => setPageIndex((n) => n + 1)}
                        >
                          {t('next')}
                        </button>
                      </div>
                    </div>
                  </section>
                )}
                {page === 'locations' && (
                  <div className="inv-location-grid">
                    {active(data.locations).map((l) => (
                      <section className="inv-card" key={l.id}>
                        <div className="inv-card-title">
                          <div>
                            <MapPin size={20} />
                            <h2>{name(l)}</h2>
                            <small>{l.parent_id ? name(find('locations', l.parent_id)) : 'Stockroom'}</small>
                          </div>
                          {!data.readOnly && (
                            <button onClick={() => setForm({ type: 'locations', row: l })}>
                              {t('edit')}
                            </button>
                          )}
                        </div>
                        {table(
                          [t('product'), t('quantity')],
                          data.balances
                            .filter((b) => b.location_id === l.id)
                            .map((b) => [name(find('products', b.product_id)), num(b.quantity)]),
                        )}
                      </section>
                    ))}
                    {!data.readOnly && (
                      <button className="inv-card inv-empty" onClick={() => setForm({ type: 'movement' })}>
                        <ArrowDownUp />
                        {t('transfer')}
                      </button>
                    )}
                  </div>
                )}
                {page === 'analytics' && (
                  <Analytics
                    data={data}
                    locale={locale}
                    days={days}
                    setDays={setDays}
                    exportRows={exportRows}
                  />
                )}
                {page === 'insights' && (
                  <div className="inv-insight-grid">
                    {products
                      .filter((p) => suggestion(data, p).needed > 0)
                      .map((p) => {
                        const s = suggestion(data, p)
                        return (
                          <section className="inv-card inv-insight" key={p.id}>
                            <div className="inv-card-title">
                              <div>
                                <small>{p.sku}</small>
                                <h2>{name(p)}</h2>
                              </div>
                              {badge(stockStatus(s.stock, Number(p.reorder_point)))}
                            </div>
                            <dl>
                              {[
                                ['stock', s.stock],
                                ['transit', s.inTransit],
                                ['daily', s.daily],
                                ['target', s.target],
                              ].map(([k, v]) => (
                                <div key={k}>
                                  <dt>{t(String(k))}</dt>
                                  <dd>{num(v)}</dd>
                                </div>
                              ))}
                            </dl>
                            <div className="inv-insight-footer">
                              <span>
                                {t('suggested')} <strong>{num(s.needed)}</strong>
                              </span>
                              {!data.readOnly && (
                                <button
                                  className="inv-primary"
                                  disabled={!p.supplier_id || !active(data.locations).length}
                                  onClick={() => setForm({ type: 'order', productId: p.id })}
                                >
                                  {t(p.supplier_id ? 'createDraft' : 'noSupplier')}
                                </button>
                              )}
                            </div>
                          </section>
                        )
                      })}
                    {!products.some((p) => suggestion(data, p).needed > 0) && (
                      <div className="inv-card inv-empty">{t('empty')}</div>
                    )}
                  </div>
                )}
              </>
            )
          )}
        </main>
      </div>
      <Modal
        open={!!form}
        title={
          form
            ? t(
                form.type === 'order'
                  ? 'newOrder'
                  : form.type === 'movement'
                    ? 'logMovement'
                    : form.type === 'receive'
                      ? 'receive'
                      : form.type === 'import'
                        ? 'importPreview'
                        : form.type,
              )
            : ''
        }
        locale={locale}
        onClose={() => {
          if (!busy) {
            setForm(null)
            setError('')
          }
        }}
      >
        {form && data && (
          <Editor
            key={`${form.type}-${form.row?.id ?? form.productId ?? 'new'}`}
            form={form}
            data={data}
            locale={locale}
            busy={busy}
            error={error}
            submit={execute}
            cancel={() => {
              setForm(null)
              setError('')
            }}
          />
        )}
      </Modal>
      <Modal
        open={!!detail}
        title={detail?.type === 'orders' ? String(detail.row.number) : name(detail?.row)}
        locale={locale}
        onClose={() => setDetail(null)}
      >
        {detail && data && (
          <>
            {detail.type === 'products' && (
              <>
                <dl className="inv-detail">
                  {['sku', 'description', 'unit', 'cost', 'price', 'reorder_point', 'reorder_quantity'].map(
                    (k) => (
                      <div key={k}>
                        <dt>{t(k)}</dt>
                        <dd>{String(detail.row[k] ?? '—')}</dd>
                      </div>
                    ),
                  )}
                </dl>
                {table(
                  [t('location'), t('stock')],
                  data.balances
                    .filter((b) => b.product_id === detail.row.id)
                    .map((b) => [name(find('locations', b.location_id)), num(b.quantity)]),
                )}
              </>
            )}
            {detail.type === 'suppliers' && (
              <>
                <dl className="inv-detail">
                  {['contact', 'email', 'phone', 'lead_days'].map((k) => (
                    <div key={k}>
                      <dt>{t(k)}</dt>
                      <dd>{String(detail.row[k] ?? '—')}</dd>
                    </div>
                  ))}
                </dl>
                {table(
                  [t('product'), t('sku')],
                  data.products.filter((p) => p.supplier_id === detail.row.id).map((p) => [name(p), p.sku]),
                )}
                {table(
                  [t('number'), t('status')],
                  data.orders
                    .filter((o) => o.supplier_id === detail.row.id)
                    .map((o) => [o.number, t(o.status === 'received' ? 'received_order' : String(o.status))]),
                )}
              </>
            )}
            {detail.type === 'orders' && (
              <>
                <p>
                  {name(find('suppliers', detail.row.supplier_id))} ·{' '}
                  {t(detail.row.status === 'received' ? 'received_order' : String(detail.row.status))} ·{' '}
                  {date(detail.row.expected_at)}
                </p>
                <p>{detail.row.notes}</p>
                {table(
                  [t('product'), t('location'), t('ordered'), t('receivedQty'), t('cost')],
                  data.order_items
                    .filter((i) => i.order_id === detail.row.id)
                    .map((i) => [
                      name(find('products', i.product_id)),
                      name(find('locations', i.location_id)),
                      num(i.quantity),
                      num(i.received),
                      money(i.cost),
                    ]),
                )}
              </>
            )}
            {!data.readOnly && (
              <div className="inv-form-actions">
                {detail.type !== 'orders' ? (
                  <button
                    className="inv-primary"
                    onClick={() => {
                      setForm({
                        type: detail.type as 'products' | 'suppliers',
                        row: detail.row,
                      })
                      setDetail(null)
                    }}
                  >
                    {t('edit')}
                  </button>
                ) : (
                  <>
                    {detail.row.status === 'draft' && (
                      <>
                        <button
                          onClick={() => {
                            setForm({ type: 'order', row: detail.row })
                            setDetail(null)
                          }}
                        >
                          {t('edit')}
                        </button>
                        <button
                          className="inv-primary"
                          disabled={busy}
                          onClick={() =>
                            void execute({
                              action: 'status',
                              id: detail.row.id,
                              status: 'submitted',
                            })
                          }
                        >
                          {t('submit')}
                        </button>
                      </>
                    )}
                    {['submitted', 'partial'].includes(String(detail.row.status)) && (
                      <button
                        className="inv-primary"
                        onClick={() => {
                          setForm({ type: 'receive', row: detail.row })
                          setDetail(null)
                        }}
                      >
                        {t('receive')}
                      </button>
                    )}
                    {['draft', 'submitted', 'partial'].includes(String(detail.row.status)) && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void execute({
                            action: 'status',
                            id: detail.row.id,
                            status: 'cancelled',
                          })
                        }
                      >
                        {t('cancelOrder')}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            {error && (
              <p role="alert" className="inv-error">
                {t(error)}
              </p>
            )}
          </>
        )}
      </Modal>
    </div>
  )
}

function Modal({
  open,
  title,
  locale,
  onClose,
  children,
}: {
  open: boolean
  title: string
  locale: Locale
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="inv-modal-backdrop" />
        <Dialog.Popup className="inventory-app inv-modal">
          <Dialog.Title>{title}</Dialog.Title>
          <button className="inv-modal-close" aria-label={translate(locale, 'close')} onClick={onClose}>
            <X size={18} />
          </button>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Editor({
  form,
  data,
  locale,
  busy,
  error,
  submit,
  cancel,
}: {
  form: Form
  data: InventoryData
  locale: Locale
  busy: boolean
  error: string
  submit: (c: Record<string, unknown>) => Promise<void>
  cancel: () => void
}) {
  const t = (key: string) => translate(locale, key)
  const name = (row: Row | undefined) => displayName(row, locale)
  const initialProduct = data.products.find((p) => p.id === form.productId)
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      Object.entries(form.row ?? {}).map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v ?? '')]),
    ),
  )
  const [kind, setKind] = useState('received')
  const [productId, setProductId] = useState(form.productId ?? '')
  const [locationId, setLocationId] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const [count, setCount] = useState('1')
  const [note, setNote] = useState(String(form.row?.notes ?? ''))
  const [supplierId, setSupplierId] = useState(
    String(form.row?.supplier_id ?? initialProduct?.supplier_id ?? ''),
  )
  const [expected, setExpected] = useState(() =>
    String(form.row?.expected_at ?? new Date(Date.now() + 7 * 86400000).toISOString()).slice(0, 10),
  )
  const [lines, setLines] = useState(() =>
    form.row && form.type === 'order'
      ? data.order_items
          .filter((i) => i.order_id === form.row!.id)
          .map((i) => ({
            product_id: String(i.product_id),
            location_id: String(i.location_id),
            quantity: Number(i.quantity),
            cost: Number(i.cost),
          }))
      : initialProduct
        ? [
            {
              product_id: initialProduct.id,
              location_id: active(data.locations)[0]?.id ?? '',
              quantity: suggestion(data, initialProduct).needed,
              cost: Number(initialProduct.cost),
            },
          ]
        : [],
  )
  const [receipts, setReceipts] = useState<Record<string, string>>({})
  const [importRows, setImportRows] = useState<Record<string, string>[]>([])
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [localError, setLocalError] = useState('')
  const set = (key: string, value: string | boolean) => setValues((v) => ({ ...v, [key]: value }))
  const select = (
    label: string,
    value: string,
    setValue: (s: string) => void,
    rows: Row[],
    required = true,
  ) => (
    <label className="inv-field">
      <span>
        {t(label)}
        {required ? ' *' : ''}
      </span>
      <Select
        name={label}
        required={required}
        value={value || null}
        onValueChange={(next) => setValue(next ?? '')}
      >
        <SelectTrigger aria-label={t(label)} className="w-full">
          <SelectValue placeholder="—">
            {(next) => {
              const row = rows.find((row) => row.id === next)
              return row ? name(row) : '—'
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="inv-select-popup" positionerClassName="inv-select-positioner">
          <SelectItem value={null}>—</SelectItem>
          {rows.map((row) => (
            <SelectItem key={row.id} value={row.id}>
              {name(row)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
  const input = (key: string, type = 'text', required = false) => (
    <label className="inv-field" key={key}>
      <span>
        {t(key)}
        {required ? ' *' : ''}
      </span>
      <input
        required={required}
        type={type}
        min={type === 'number' ? 0 : undefined}
        max={type === 'number' ? 1e12 : undefined}
        step={type === 'number' ? 'any' : undefined}
        maxLength={type === 'text' ? 160 : undefined}
        value={String(values[key] ?? (type === 'number' ? '0' : ''))}
        onChange={(e) => set(key, e.target.value)}
      />
    </label>
  )
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLocalError('')
    if (['products', 'suppliers', 'locations'].includes(form.type)) {
      const fields =
        form.type === 'products'
          ? ['cost', 'price', 'reorder_point', 'reorder_quantity']
          : form.type === 'suppliers'
            ? ['lead_days']
            : []
      const payload: Record<string, unknown> = {
        ...values,
        archived: values.archived ?? false,
      }
      for (const field of fields) payload[field] = Number(values[field] ?? 0)
      for (const field of ['category_id', 'supplier_id', 'parent_id'])
        if (field in payload) payload[field] = payload[field] || null
      await submit({
        action: 'save',
        table: form.type,
        id: form.row?.id,
        values: payload,
      })
    } else if (form.type === 'movement')
      await submit({
        action: 'movement',
        kind,
        productId,
        locationId,
        destinationId: destinationId || null,
        quantity: Number(count),
        note,
      })
    else if (form.type === 'order') {
      if (!lines.length) {
        setLocalError('invalid_input')
        return
      }
      await submit({
        action: 'order',
        id: form.row?.id,
        supplierId,
        expectedAt: new Date(expected + 'T12:00:00').toISOString(),
        notes: note,
        items: lines,
      })
    } else if (form.type === 'receive') {
      const items = Object.entries(receipts)
        .filter(([, quantity]) => Number(quantity) > 0)
        .map(([id, quantity]) => ({ id, quantity: Number(quantity) }))
      if (!items.length) {
        setLocalError('positive_quantity')
        return
      }
      await submit({ action: 'receive', id: form.row!.id, items })
    } else if (form.type === 'import')
      await submit({
        action: 'import',
        products: importRows.map((row) => ({
          ...row,
          cost: Number(row.cost),
          price: Number(row.price),
          reorder_point: Number(row.reorder_point),
          reorder_quantity: Number(row.reorder_quantity),
          archived: false,
        })),
      })
  }
  async function fileChange(file: File | undefined) {
    setImportRows([])
    setImportErrors([])
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setImportErrors(['csv_rows'])
      return
    }
    try {
      const [headers, ...rows] = parseCsv(await file.text())
      if (
        !headers ||
        !['name', 'sku', 'cost', 'price', 'reorder_point', 'reorder_quantity'].every((k) =>
          headers.includes(k),
        )
      )
        throw new Error('csv_headers')
      if (!rows.length || rows.length > 500) throw new Error('csv_rows')
      const errors: string[] = []
      const seen = new Set(data.products.map((p) => String(p.sku)))
      const mapped = rows.map((row, index) => {
        const item = Object.fromEntries(headers.map((header, i) => [header, row[i]?.trim() ?? '']))
        if (
          !item.name ||
          !item.sku ||
          ['cost', 'price', 'reorder_point', 'reorder_quantity'].some(
            (k) => !item[k] || !Number.isFinite(Number(item[k])) || Number(item[k]) < 0,
          )
        )
          errors.push(`${index + 2}: invalid_input`)
        if (seen.has(item.sku)) errors.push(`${index + 2}: duplicate_sku`)
        seen.add(item.sku)
        return item
      })
      setImportRows(mapped)
      setImportErrors(errors)
    } catch (e) {
      setImportErrors([e instanceof Error ? e.message : 'csv_invalid'])
    }
  }
  return (
    <form onSubmit={onSubmit} className="inv-editor">
      {(error || localError) && (
        <p role="alert" className="inv-error">
          {t(error || localError)}
        </p>
      )}
      {['products', 'suppliers', 'locations'].includes(form.type) && (
        <div className="inv-form-grid">
          {input('name', 'text', true)}
          {input('name_en')}
          {form.type === 'products' && (
            <>
              {input('sku', 'text', true)}
              {input('unit')}
              {select(
                'category_id',
                String(values.category_id ?? ''),
                (s) => set('category_id', s),
                data.categories,
                false,
              )}
              {select(
                'supplier_id',
                String(values.supplier_id ?? ''),
                (s) => set('supplier_id', s),
                active(data.suppliers),
                false,
              )}
              {['cost', 'price', 'reorder_point', 'reorder_quantity'].map((k) => input(k, 'number'))}
              <label className="inv-field inv-span">
                <span>{t('description')}</span>
                <textarea
                  maxLength={2000}
                  value={String(values.description ?? '')}
                  onChange={(e) => set('description', e.target.value)}
                />
              </label>
            </>
          )}
          {form.type === 'suppliers' && (
            <>
              {input('contact')}
              {input('email', 'email')}
              {input('phone')}
              {input('lead_days', 'number')}
            </>
          )}
          {form.type === 'locations' &&
            select(
              'parent_id',
              String(values.parent_id ?? ''),
              (s) => set('parent_id', s),
              active(data.locations).filter((l) => l.id !== form.row?.id),
              false,
            )}
          {form.row && (
            <label className="inv-checkbox">
              <input
                type="checkbox"
                checked={!!values.archived}
                onChange={(e) => set('archived', e.target.checked)}
              />
              {t('archived')}
            </label>
          )}
        </div>
      )}
      {form.type === 'movement' && (
        <div className="inv-form-grid">
          {select('product', productId, setProductId, active(data.products))}
          <label className="inv-field">
            <span>{t('kind')}</span>
            <Select
              value={kind}
              onValueChange={(next) => {
                if (next !== null) setKind(next)
              }}
            >
              <SelectTrigger aria-label={t('kind')} className="w-full">
                <SelectValue>{(next) => t(String(next))}</SelectValue>
              </SelectTrigger>
              <SelectContent className="inv-select-popup" positionerClassName="inv-select-positioner">
                {['received', 'shipped', 'adjusted', 'transferred'].map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(kind)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {select('location', locationId, setLocationId, active(data.locations))}
          {kind === 'transferred' &&
            select(
              'destination',
              destinationId,
              setDestinationId,
              active(data.locations).filter((l) => l.id !== locationId),
            )}
          <label className="inv-field">
            <span>{t(kind === 'adjusted' ? 'counted' : 'quantity')}</span>
            <input
              type="number"
              min={kind === 'adjusted' ? 0 : 0.001}
              step="any"
              required
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />
          </label>
          <label className="inv-field inv-span">
            <span>{t('note')}</span>
            <textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
      )}
      {form.type === 'order' && (
        <>
          <div className="inv-form-grid">
            {select(
              'supplier',
              supplierId,
              (s) => {
                setSupplierId(s)
                setLines([])
              },
              active(data.suppliers),
            )}
            <label className="inv-field">
              <span>{t('expected')} *</span>
              <input required type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
            </label>
            <label className="inv-field inv-span">
              <span>{t('note')}</span>
              <textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
          <div className="inv-order-lines">
            {lines.map((line, index) => (
              <div className="inv-line" key={index}>
                {select(
                  'product',
                  line.product_id,
                  (id) => {
                    const product = data.products.find((p) => p.id === id)
                    setLines((rows) =>
                      rows.map((l, i) =>
                        i === index
                          ? {
                              ...l,
                              product_id: id,
                              cost: Number(product?.cost ?? 0),
                            }
                          : l,
                      ),
                    )
                  },
                  active(data.products).filter((p) => p.supplier_id === supplierId),
                )}
                {select(
                  'location',
                  line.location_id,
                  (id) =>
                    setLines((rows) => rows.map((l, i) => (i === index ? { ...l, location_id: id } : l))),
                  active(data.locations),
                )}
                {(['quantity', 'cost'] as const).map((k) => (
                  <label className="inv-field" key={k}>
                    <span>{t(k)}</span>
                    <input
                      type="number"
                      min={k === 'quantity' ? 0.001 : 0}
                      step="any"
                      required
                      value={line[k]}
                      onChange={(e) =>
                        setLines((rows) =>
                          rows.map((l, i) => (i === index ? { ...l, [k]: Number(e.target.value) } : l)),
                        )
                      }
                    />
                  </label>
                ))}
                <button
                  type="button"
                  aria-label={t('remove')}
                  onClick={() => setLines((rows) => rows.filter((_, i) => i !== index))}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={!supplierId}
            onClick={() =>
              setLines((rows) => [...rows, { product_id: '', location_id: '', quantity: 1, cost: 0 }])
            }
          >
            <Plus size={16} />
            {t('addLine')}
          </button>
        </>
      )}
      {form.type === 'receive' && (
        <div className="inv-order-lines">
          {data.order_items
            .filter((i) => i.order_id === form.row!.id && Number(i.received) < Number(i.quantity))
            .map((item) => (
              <label className="inv-field" key={item.id}>
                <span>
                  {name(data.products.find((p) => p.id === item.product_id))} · {t('receivedQty')}{' '}
                  {String(item.received)} / {String(item.quantity)}
                </span>
                <input
                  aria-label={`${name(data.products.find((p) => p.id === item.product_id))} ${t('receiveNow')}`}
                  type="number"
                  min={0}
                  max={Number(item.quantity) - Number(item.received)}
                  step="any"
                  value={receipts[item.id] ?? '0'}
                  onChange={(e) => setReceipts((r) => ({ ...r, [item.id]: e.target.value }))}
                />
              </label>
            ))}
        </div>
      )}
      {form.type === 'import' && (
        <>
          <p>{t('importHelp')}</p>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label={t('import')}
            onChange={(e) => void fileChange(e.target.files?.[0])}
          />
          {importErrors.length > 0 && (
            <div className="inv-error">
              <strong>{t('invalidRows')}</strong>
              {importErrors.slice(0, 20).map((error, i) => (
                <p key={i}>
                  {error.includes(': ')
                    ? `${t('row')} ${error.split(': ')[0]}: ${t(error.split(': ')[1])}`
                    : t(error)}
                </p>
              ))}
            </div>
          )}
          {importRows.length > 0 && (
            <div className="inv-table-scroll">
              <p>
                {importRows.length} {t('products')}
              </p>
              <table>
                <thead>
                  <tr>
                    {['name', 'sku', 'cost'].map((k) => (
                      <th key={k}>{t(k)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {importRows.slice(0, 10).map((r, i) => (
                    <tr key={i}>
                      <td>{r.name}</td>
                      <td>{r.sku}</td>
                      <td>{r.cost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <div className="inv-form-actions">
        <button type="button" disabled={busy} onClick={cancel}>
          {t('cancel')}
        </button>
        <button
          className="inv-primary"
          type="submit"
          disabled={busy || (form.type === 'import' && (!importRows.length || !!importErrors.length))}
        >
          {t(busy ? 'saving' : form.type === 'import' ? 'confirmImport' : 'save')}
        </button>
      </div>
    </form>
  )
}

function Analytics({
  data,
  locale,
  days,
  setDays,
  exportRows,
}: {
  data: InventoryData
  locale: Locale
  days: number
  setDays: (n: number) => void
  exportRows: (rows: unknown[][], name: string) => void
}) {
  const t = (key: string) => translate(locale, key)
  const name = (row: Row) => displayName(row, locale)
  const [category, setCategory] = useState('')
  const [supplier, setSupplier] = useState('')
  const [location, setLocation] = useState('')
  const products = active(data.products).filter(
    (p) => (!category || p.category_id === category) && (!supplier || p.supplier_id === supplier),
  )
  const productIds = new Set(products.map((p) => p.id))
  const [now] = useState(Date.now)
  const cutoff = now - days * 86400000
  const movements = data.movements.filter(
    (m) =>
      productIds.has(String(m.product_id)) &&
      (!location || m.location_id === location || m.destination_id === location) &&
      Date.parse(String(m.created_at)) >= cutoff,
  )
  const categories = data.categories.map((c) => ({
    label: name(c),
    value: products
      .filter((p) => p.category_id === c.id)
      .reduce((s, p) => s + Number(p.cost) * quantity(data, p.id, location), 0),
  }))
  const counts = { in: 0, low: 0, out: 0 }
  for (const p of products) counts[stockStatus(quantity(data, p.id, location), Number(p.reorder_point))]++
  const trend = Array.from({ length: days }, (_, i) => {
    const day = new Date(now - (days - 1 - i) * 86400000).toISOString().slice(0, 10)
    return {
      label: day.slice(5),
      received: movements
        .filter((m) => String(m.created_at).startsWith(day) && m.kind === 'received')
        .reduce((s, m) => s + Number(m.quantity), 0),
      shipped: movements
        .filter((m) => String(m.created_at).startsWith(day) && m.kind === 'shipped')
        .reduce((s, m) => s + Number(m.quantity), 0),
    }
  })
  const max = Math.max(1, ...trend.flatMap((d) => [d.received, d.shipped]))
  const money = (v: number) =>
    new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
      style: 'currency',
      currency: 'CNY',
      maximumFractionDigits: 0,
    }).format(v)
  const totals = data.suppliers
    .filter((s) => !supplier || s.id === supplier)
    .map((s) => ({
      name: name(s),
      total: data.order_items
        .filter(
          (i) =>
            productIds.has(String(i.product_id)) &&
            (!location || i.location_id === location) &&
            data.orders.some(
              (o) =>
                o.id === i.order_id &&
                o.supplier_id === s.id &&
                o.status !== 'cancelled' &&
                Date.parse(String(o.created_at)) >= cutoff,
            ),
        )
        .reduce((sum, i) => sum + Number(i.cost) * Number(i.quantity), 0),
    }))
  return (
    <>
      <div className="inv-filters inv-card">
        <label className="inv-filter">
          <span>{t('date')}</span>
          <Select
            value={days}
            onValueChange={(next) => {
              if (next !== null) setDays(next)
            }}
          >
            <SelectTrigger aria-label={t('date')}>
              <SelectValue>{(next) => t('days' + next)}</SelectValue>
            </SelectTrigger>
            <SelectContent className="inv-select-popup" positionerClassName="inv-select-positioner">
              {[7, 30, 90].map((days) => (
                <SelectItem key={days} value={days}>
                  {t('days' + days)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {[
          ['category', category, setCategory, data.categories],
          ['supplier', supplier, setSupplier, active(data.suppliers)],
          ['location', location, setLocation, active(data.locations)],
        ].map(([key, value, set, rows]) => (
          <label className="inv-filter" key={String(key)}>
            <span>{t(String(key))}</span>
            <Select
              value={String(value)}
              onValueChange={(next) => {
                if (next !== null) (set as (s: string) => void)(next)
              }}
            >
              <SelectTrigger aria-label={t(String(key))}>
                <SelectValue>
                  {(next) => {
                    const row = (rows as Row[]).find((row) => row.id === next)
                    return row ? name(row) : t('all')
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="inv-select-popup" positionerClassName="inv-select-positioner">
                <SelectItem value="">{t('all')}</SelectItem>
                {(rows as Row[]).map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {name(row)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ))}
        <button
          onClick={() =>
            exportRows(
              [
                [t('date'), t('received'), t('shipped')],
                ...trend.map((d) => [d.label, d.received, d.shipped]),
              ],
              'inventory-trends.csv',
            )
          }
        >
          <Download size={16} />
          {t('export')}
        </button>
      </div>
      <div className="inv-dashboard-grid">
        <section className="inv-card inv-chart">
          <h2>{t('categoryChart')}</h2>
          {categories.map((c) => (
            <div className="inv-bar-row" key={c.label}>
              <span>{c.label}</span>
              <meter min={0} max={Math.max(1, ...categories.map((c) => c.value))} value={c.value} />
              <b>{money(c.value)}</b>
            </div>
          ))}
        </section>
        <section className="inv-card inv-chart">
          <h2>{t('statusChart')}</h2>
          <div className="inv-status-chart">
            {Object.entries(counts).map(([k, v]) => (
              <div key={k}>
                <span className={`inv-badge inv-${k}`}>{t(k)}</span>
                <strong>{v}</strong>
                <small>{products.length ? Math.round((v / products.length) * 100) : 0}%</small>
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="inv-card inv-chart">
        <div className="inv-card-title">
          <h2>{t('trend')}</h2>
          <div>
            <span className="inv-positive">● {t('received')}</span>　
            <span className="inv-negative">● {t('shipped')}</span>
          </div>
        </div>
        <svg viewBox="0 0 900 200" role="img" aria-label={t('trend')} className="inv-trend">
          <line x1="25" x2="890" y1="165" y2="165" stroke="currentColor" opacity=".15" />
          {trend.map((d, i) => (
            <g key={i}>
              <title>
                {d.label}: {t('received')} {d.received}, {t('shipped')} {d.shipped}
              </title>
              <rect
                x={30 + (i * 850) / days}
                y={165 - (d.received / max) * 140}
                width={Math.max(2, 330 / days)}
                height={(d.received / max) * 140}
                className="inv-received-bar"
              />
              <rect
                x={30 + (i * 850) / days + 340 / days}
                y={165 - (d.shipped / max) * 140}
                width={Math.max(2, 330 / days)}
                height={(d.shipped / max) * 140}
                className="inv-shipped-bar"
              />
              {i % Math.max(1, Math.floor(days / 7)) === 0 && (
                <text x={30 + (i * 850) / days} y="190" fontSize="12">
                  {d.label}
                </text>
              )}
            </g>
          ))}
        </svg>
      </section>
      <section className="inv-card inv-chart">
        <h2>{t('supplierReport')}</h2>
        <div className="inv-table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('supplier')}</th>
                <th>{t('total')}</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>{money(row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
