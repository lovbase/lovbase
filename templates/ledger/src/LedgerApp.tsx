import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import {
  ArrowLeftRight,
  BarChart3,
  Download,
  LayoutDashboard,
  Pencil,
  PiggyBank,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  Undo2,
  Wallet,
  X,
} from 'lucide-react'
import {
  BASE_CURRENCY,
  accountKinds,
  balances,
  budgetProgress,
  cashFlow,
  currencies,
  isMoney,
  lastMonths,
  localized,
  money,
  monthOf,
  netWorthSeries,
  parseAmount,
  planEntry,
  postingsCsv,
  rateOf,
  sign,
  spendingByCategory,
  type Account,
  type AccountKind,
  type Currency,
  type Entry,
  type LedgerClient,
  type LedgerCommand,
  type LedgerData,
  type Locale,
  type Posting,
  type RecordInput,
} from '@lovbase/core/ledger'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { translate } from './labels'
import './ledger.css'

type Page = 'overview' | 'transactions' | 'accounts' | 'budgets' | 'reports'
type Form =
  | { type: 'entry'; kind: RecordInput['kind'] }
  | { type: 'account'; account?: Account }
  | { type: 'reverse'; entry: Entry }
  | { type: 'budget'; account: Account; month: string; cents: number }
  | { type: 'rate'; currency: Currency; rate: number }
type Command = LedgerCommand extends infer C ? (C extends unknown ? Omit<C, 'requestId'> : never) : never
type Row = { entry: Entry; postings: Posting[]; reversed: boolean }

const navigation: [Page, typeof Wallet][] = [
  ['overview', LayoutDashboard],
  ['transactions', ReceiptText],
  ['accounts', Wallet],
  ['budgets', PiggyBank],
  ['reports', BarChart3],
]
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const amountText = (cents: number) => (cents / 100).toFixed(2)
function monthLabel(month: string, locale: Locale, long = false) {
  const [y, m] = month.split('-').map(Number)
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: long ? 'long' : 'short',
    ...(long ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, 1)))
}
function dayLabel(day: string, locale: Locale) {
  const [y, m, d] = day.split('-').map(Number)
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)))
}

export function LedgerApp({
  client,
  initialLocale = 'en',
  locale: controlledLocale,
  onLocaleChange,
  initialData,
}: {
  client: LedgerClient
  initialLocale?: Locale
  locale?: Locale
  onLocaleChange?: (locale: Locale) => void
  initialData?: LedgerData
}) {
  const [localLocale, setLocalLocale] = useState<Locale>(initialLocale)
  const locale = controlledLocale ?? localLocale
  const t = (key: string) => translate(locale, key)
  const [data, setData] = useState<LedgerData | null>(initialData ?? null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(!initialData)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [page, setPage] = useState<Page>('overview')
  const [form, setForm] = useState<Form | null>(null)
  const [query, setQuery] = useState('')
  const [accountFilter, setAccountFilter] = useState('')
  const [monthFilter, setMonthFilter] = useState('')
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
  }, [initialData, read])
  const switchLocale = (next: Locale) => {
    setLocalLocale(next)
    onLocaleChange?.(next)
  }

  // A retry of the same form reuses its request id, so a lost response never books twice.
  const run = async (command: Command) => {
    if (busy || data?.readOnly) return
    const key = JSON.stringify(command)
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() }
    setBusy(true)
    setFormError('')
    try {
      await client.command({ ...command, requestId: pending.current.id } as LedgerCommand)
      setData(await client.read())
      pending.current = null
      setForm(null)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'generic_error')
    } finally {
      setBusy(false)
    }
  }
  const open = (next: Form) => {
    setFormError('')
    setForm(next)
  }

  const view = useMemo(() => {
    if (!data) return null
    const accounts = new Map(data.accounts.map((a) => [a.id, a]))
    const byEntry = new Map<string, Posting[]>()
    for (const p of data.postings) byEntry.set(p.entry_id, [...(byEntry.get(p.entry_id) ?? []), p])
    const reversed = new Set(data.entries.map((e) => e.reverses).filter(Boolean))
    const rows: Row[] = data.entries
      .map((entry) => ({ entry, postings: byEntry.get(entry.id) ?? [], reversed: reversed.has(entry.id) }))
      .sort(
        (a, b) =>
          b.entry.occurred_on.localeCompare(a.entry.occurred_on) ||
          b.entry.created_at.localeCompare(a.entry.created_at),
      )
    // A real ledger always opens on the current month. The demo opens on its latest month with a
    // payday, so a gallery visitor early in the month does not land on an empty income figure.
    const payday = rows.find((r) => r.entry.kind === 'income')
    const current = data.readOnly && payday ? monthOf(payday.entry.occurred_on) : monthOf(today())
    const months = lastMonths(current, 6)
    return {
      accounts,
      rows,
      current,
      months,
      balances: balances(data),
      flow: cashFlow(data, months),
    }
  }, [data])

  const name = (a: { name: string; name_en: string } | undefined) => (a ? localized(a, locale) : '—')
  const describe = (row: Row) => {
    const legs = [...row.postings].sort((a, b) => a.amount_cents - b.amount_cents)
    const from = view!.accounts.get(legs[0]?.account_id ?? '')
    const to = view!.accounts.get(legs[legs.length - 1]?.account_id ?? '')
    const moneyLeg =
      row.entry.kind === 'income'
        ? legs[legs.length - 1]
        : row.entry.kind === 'transfer'
          ? legs[0]
          : (legs.find((p) => isMoney(view!.accounts.get(p.account_id) ?? { kind: 'equity' })) ?? legs[0])
    const account = view!.accounts.get(moneyLeg?.account_id ?? '')
    const effective = row.entry.kind === 'reversal' ? -1 : 1
    const kindOf = (e: Entry) =>
      e.kind === 'reversal' ? data!.entries.find((x) => x.id === e.reverses)?.kind ?? 'expense' : e.kind
    const base = kindOf(row.entry)
    const tone =
      base === 'transfer' || base === 'opening'
        ? 'neutral'
        : (base === 'income') === (effective === 1)
          ? 'in'
          : 'out'
    return {
      title: row.entry.payee || row.entry.memo || t(row.entry.kind),
      route: `${name(from)} → ${name(to)}`,
      amount: moneyLeg ? money(moneyLeg.amount_cents, account?.currency ?? BASE_CURRENCY, locale) : '',
      tone,
    }
  }
  const entryLine = (row: Row, compact = false) => {
    const d = describe(row)
    return (
      <li key={row.entry.id} className={`led-entry${row.reversed ? ' is-reversed' : ''}`}>
        <time>{dayLabel(row.entry.occurred_on, locale)}</time>
        <div className="led-entry-main">
          <strong>{d.title}</strong>
          <span>
            {d.route}
            {row.entry.memo && row.entry.payee && !compact ? ` · ${row.entry.memo}` : ''}
          </span>
        </div>
        <div className="led-entry-tags">
          {row.entry.kind !== 'expense' && row.entry.kind !== 'income' && (
            <span className={`led-tag led-tag-${row.entry.kind}`}>{t(row.entry.kind)}</span>
          )}
          {row.reversed && <span className="led-tag">{t('reversed')}</span>}
        </div>
        <span className={`led-amount led-${d.tone}`}>{d.amount}</span>
        {!compact && (
          <span className="led-entry-actions">
            {!data?.readOnly && !row.reversed && row.entry.kind !== 'reversal' && (
              <button
                className="led-icon"
                title={t('reverse')}
                aria-label={t('reverse')}
                onClick={() => open({ type: 'reverse', entry: row.entry })}
              >
                <Undo2 size={15} />
              </button>
            )}
          </span>
        )}
      </li>
    )
  }

  const exportCsv = () => {
    if (!data) return
    const url = URL.createObjectURL(new Blob(['﻿' + postingsCsv(data, locale)], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `ledger-${today()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!data || !view)
    return (
      <div className="ledger-app led-center">
        {error ? (
          <div>
            <p>{t(error)}</p>
            <button onClick={() => void read()}>{t('retry')}</button>
          </div>
        ) : (
          <p className="led-muted">{loading ? t('loading') : ''}</p>
        )}
      </div>
    )

  // Oldest first within each kind: the order the books were set up in, not the order of the read.
  const ordered = [...data.accounts].sort(
    (a, b) => accountKinds.indexOf(a.kind) - accountKinds.indexOf(b.kind) || a.created_at.localeCompare(b.created_at),
  )
  const active = ordered.filter((a) => !a.archived)
  const moneyAccounts = active.filter(isMoney)
  const thisMonth = view.flow[view.flow.length - 1]
  const netWorth = data.accounts.filter(isMoney).reduce((sum, a) => sum + view.balances.get(a.id)!.base, 0)

  const overview = (
    <>
      <section className="led-kpis">
        <Kpi label={t('netWorth')} value={money(netWorth, BASE_CURRENCY, locale)} hint={t('netWorthHint')} />
        <Kpi label={`${t('income')} · ${monthLabel(view.current, locale)}`} value={money(thisMonth.income, BASE_CURRENCY, locale)} tone="in" />
        <Kpi label={`${t('spending')} · ${monthLabel(view.current, locale)}`} value={money(thisMonth.expense, BASE_CURRENCY, locale)} tone="out" />
        <Kpi
          label={t('savingsRate')}
          value={thisMonth.income > 0 ? `${Math.round(((thisMonth.income - thisMonth.expense) / thisMonth.income) * 100)}%` : '—'}
          hint={monthLabel(view.current, locale, true)}
        />
      </section>
      <div className="led-grid">
        <Panel title={t('cashFlow')} className="led-span-2">
          <CashFlowChart rows={view.flow} locale={locale} t={t} />
        </Panel>
        <Panel title={t('budgetWatch')} action={<button className="led-link" onClick={() => setPage('budgets')}>{t('seeAll')}</button>}>
          <BudgetBars lines={budgetProgress(data, view.current).filter((l) => l.budget).slice(0, 5)} locale={locale} t={t} />
        </Panel>
        <Panel title={t('recent')} className="led-span-3" action={<button className="led-link" onClick={() => setPage('transactions')}>{t('seeAll')}</button>}>
          <ul className="led-entries">{view.rows.slice(0, 7).map((row) => entryLine(row, true))}</ul>
        </Panel>
      </div>
    </>
  )

  const filtered = view.rows.filter(
    (row) =>
      (!accountFilter || row.postings.some((p) => p.account_id === accountFilter)) &&
      (!monthFilter || monthOf(row.entry.occurred_on) === monthFilter) &&
      `${row.entry.payee} ${row.entry.memo}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  const grouped = new Map<string, Row[]>()
  for (const row of filtered.slice(0, 400)) {
    const month = monthOf(row.entry.occurred_on)
    grouped.set(month, [...(grouped.get(month) ?? []), row])
  }
  const allMonths = [...new Set(view.rows.map((r) => monthOf(r.entry.occurred_on)))]
  const transactions = (
    <Panel>
      <div className="led-filters">
        <label className="led-search">
          <Search size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search')} />
        </label>
        <Choice
          label={t('accounts')}
          value={accountFilter}
          onChange={setAccountFilter}
          options={[['', t('allAccounts')], ...ordered.map((a): [string, string] => [a.id, name(a)])]}
        />
        <Choice
          label={t('month')}
          value={monthFilter}
          onChange={setMonthFilter}
          options={[['', t('allMonths')], ...allMonths.map((m): [string, string] => [m, monthLabel(m, locale, true)])]}
        />
      </div>
      {grouped.size === 0 && <p className="led-empty">{t('noEntries')}</p>}
      {[...grouped].map(([month, rows]) => (
        <section key={month} className="led-month">
          <h3>{monthLabel(month, locale, true)}</h3>
          <ul className="led-entries">{rows.map((row) => entryLine(row))}</ul>
        </section>
      ))}
    </Panel>
  )

  const groups: AccountKind[] = ['asset', 'liability']
  const accounts = (
    <div className="led-grid">
      {groups.map((kind) => {
        const list = ordered.filter((a) => a.kind === kind)
        const total = list.reduce((sum, a) => sum + view.balances.get(a.id)!.base * sign(kind), 0)
        return (
          <Panel key={kind} title={t(kind)} action={<span className="led-figure">{money(total, BASE_CURRENCY, locale)}</span>}>
            <ul className="led-accounts">
              {list.map((a) => {
                const b = view.balances.get(a.id)!
                return (
                  <li key={a.id} className={a.archived ? 'is-archived' : ''}>
                    <div>
                      <strong>{name(a)}</strong>
                      <span>
                        {a.currency}
                        {a.archived ? ` · ${t('archived')}` : ''}
                      </span>
                    </div>
                    <div className="led-balance">
                      <strong>{money(b.native * sign(kind), a.currency, locale)}</strong>
                      {a.currency !== BASE_CURRENCY && <span>≈ {money(b.base * sign(kind), BASE_CURRENCY, locale)}</span>}
                    </div>
                    {!data.readOnly && (
                      <button className="led-icon" aria-label={t('editAccount')} onClick={() => open({ type: 'account', account: a })}>
                        <Pencil size={14} />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </Panel>
        )
      })}
      <Panel title={t('rates')}>
        <p className="led-muted led-small">{t('ratesHint')}</p>
        <ul className="led-accounts">
          {currencies
            .filter((c) => c !== BASE_CURRENCY)
            .map((currency) => {
              let rate = 0
              try {
                rate = rateOf(data.fx_rates, currency)
              } catch {}
              return (
                <li key={currency}>
                  <div>
                    <strong>{currency}</strong>
                    <span>1 {currency}</span>
                  </div>
                  <div className="led-balance">
                    <strong>{rate ? `$${rate.toFixed(4)}` : '—'}</strong>
                  </div>
                  {!data.readOnly && (
                    <button className="led-icon" aria-label={t('rates')} onClick={() => open({ type: 'rate', currency, rate })}>
                      <Pencil size={14} />
                    </button>
                  )}
                </li>
              )
            })}
        </ul>
      </Panel>
      {(['income', 'expense'] as const).map((kind) => {
        const totals = new Map<string, number>()
        const days = new Map(data.entries.map((e) => [e.id, e.occurred_on]))
        for (const p of data.postings)
          if (monthOf(days.get(p.entry_id) ?? '') === view.current)
            totals.set(p.account_id, (totals.get(p.account_id) ?? 0) + p.base_cents * sign(kind))
        return (
          <Panel key={kind} title={t(`${kind}Kind`)} className={kind === 'expense' ? 'led-span-2' : ''} action={<span className="led-muted led-small">{t('monthTotal')}</span>}>
            <ul className={`led-accounts${kind === 'expense' ? ' led-columns' : ''}`}>
              {ordered
                .filter((a) => a.kind === kind)
                .map((a) => (
                  <li key={a.id} className={a.archived ? 'is-archived' : ''}>
                    <div>
                      <strong>{name(a)}</strong>
                      {a.archived && <span>{t('archived')}</span>}
                    </div>
                    <div className="led-balance">
                      <strong>{money(totals.get(a.id) ?? 0, BASE_CURRENCY, locale)}</strong>
                    </div>
                    {!data.readOnly && (
                      <button className="led-icon" aria-label={t('editAccount')} onClick={() => open({ type: 'account', account: a })}>
                        <Pencil size={14} />
                      </button>
                    )}
                  </li>
                ))}
            </ul>
          </Panel>
        )
      })}
    </div>
  )

  // Budgets and reports reuse the month filter; switching pages clears it.
  const budgetMonth = monthFilter && page === 'budgets' ? monthFilter : view.current
  const budgetMonths = [...view.months, nextMonth(view.current)]
  const lines = (() => {
    const progress = budgetProgress(data, budgetMonth)
    const seen = new Set(progress.map((l) => l.account.id))
    return [
      ...progress,
      ...active.filter((a) => a.kind === 'expense' && !seen.has(a.id)).map((account) => ({ account, budget: 0, spent: 0 })),
    ]
  })()
  const budgetTotal = lines.reduce((s, l) => s + l.budget, 0)
  const spentTotal = lines.reduce((s, l) => s + l.spent, 0)
  const budgets = (
    <Panel
      title={monthLabel(budgetMonth, locale, true)}
      action={
        <Choice
          label={t('month')}
          value={budgetMonth}
          onChange={setMonthFilter}
          options={budgetMonths.map((m): [string, string] => [m, monthLabel(m, locale, true)])}
        />
      }
    >
      <div className="led-budget-summary">
        <Kpi label={t('budgeted')} value={money(budgetTotal, BASE_CURRENCY, locale)} />
        <Kpi label={t('spent')} value={money(spentTotal, BASE_CURRENCY, locale)} tone="out" />
        <Kpi
          label={budgetTotal >= spentTotal ? t('remaining') : t('over')}
          value={money(Math.abs(budgetTotal - spentTotal), BASE_CURRENCY, locale)}
          tone={budgetTotal >= spentTotal ? 'in' : 'out'}
        />
      </div>
      <ul className="led-budget-list">
        {lines.map((line) => {
          const ratio = line.budget ? line.spent / line.budget : 0
          return (
            <li key={line.account.id}>
              <div className="led-budget-head">
                <strong>{name(line.account)}</strong>
                <span>
                  {money(line.spent, BASE_CURRENCY, locale)}
                  <em> / {line.budget ? money(line.budget, BASE_CURRENCY, locale) : t('unbudgeted')}</em>
                </span>
                {!data.readOnly && (
                  <button
                    className="led-icon"
                    aria-label={t('setBudget')}
                    onClick={() => open({ type: 'budget', account: line.account, month: budgetMonth, cents: line.budget })}
                  >
                    <Pencil size={14} />
                  </button>
                )}
              </div>
              <Meter ratio={ratio} empty={!line.budget} />
            </li>
          )
        })}
      </ul>
    </Panel>
  )

  const reportMonth = monthFilter && page === 'reports' ? monthFilter : view.current
  const breakdown = spendingByCategory(data, reportMonth)
  const breakdownTotal = breakdown.reduce((s, b) => s + b.cents, 0)
  const reports = (
    <div className="led-grid">
      <Panel
        title={t('spendingBreakdown')}
        className="led-span-2"
        action={
          <Choice
            label={t('month')}
            value={reportMonth}
            onChange={setMonthFilter}
            options={view.months.map((m): [string, string] => [m, monthLabel(m, locale, true)])}
          />
        }
      >
        {breakdown.length === 0 ? (
          <p className="led-empty">{t('nothingYet')}</p>
        ) : (
          <ul className="led-breakdown">
            {breakdown.map(({ account, cents }) => (
              <li key={account.id}>
                <span>{name(account)}</span>
                <div className="led-bar">
                  <i style={{ width: `${Math.max(2, (cents / breakdown[0].cents) * 100)}%` }} />
                </div>
                <strong>{money(cents, BASE_CURRENCY, locale)}</strong>
                <em>{Math.round((cents / breakdownTotal) * 100)}%</em>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={t('netWorthTrend')}>
        <p className="led-muted led-small">{t('netWorthTrendHint')}</p>
        <NetWorthChart points={netWorthSeries(data, view.months)} locale={locale} />
      </Panel>
      <Panel title={t('monthly')} className="led-span-3">
        <div className="led-table-scroll">
          <table className="led-table">
            <thead>
              <tr>
                <th>{t('month')}</th>
                <th>{t('income')}</th>
                <th>{t('spending')}</th>
                <th>{t('net')}</th>
                <th>{t('savingsRate')}</th>
              </tr>
            </thead>
            <tbody>
              {[...view.flow].reverse().map((r) => (
                <tr key={r.month}>
                  <td>{monthLabel(r.month, locale, true)}</td>
                  <td className="led-in">{money(r.income, BASE_CURRENCY, locale)}</td>
                  <td className="led-out">{money(r.expense, BASE_CURRENCY, locale)}</td>
                  <td>{money(r.income - r.expense, BASE_CURRENCY, locale)}</td>
                  <td>{r.income > 0 ? `${Math.round(((r.income - r.expense) / r.income) * 100)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )

  const content = { overview, transactions, accounts, budgets, reports }[page]
  return (
    <div className="ledger-app">
      <aside className="led-sidebar">
        <div className="led-brand">
          <span className="led-mark">$</span>
          {t('brand')}
        </div>
        <nav>
          {navigation.map(([id, Icon]) => (
            <button
              key={id}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => {
                setPage(id)
                setMonthFilter('')
              }}
            >
              <Icon size={17} />
              <span>{t(id)}</span>
            </button>
          ))}
        </nav>
      </aside>
      <div className="led-body">
        <header className="led-topbar">
          <div className="led-toolbar">
            <div className="led-language" aria-label={t('language')}>
              {(['zh', 'en'] as const).map((l) => (
                <button key={l} aria-pressed={locale === l} onClick={() => switchLocale(l)}>
                  {l === 'zh' ? '中文' : 'EN'}
                </button>
              ))}
            </div>
            <button className="led-icon" aria-label={t('refresh')} title={t('refresh')} disabled={loading} onClick={() => void read()}>
              <RefreshCw size={16} />
            </button>
          </div>
        </header>
        {data.readOnly && (
          <div className="led-demo">
            <span className="led-dot" />
            {t('readonly')}
          </div>
        )}
        <main className="led-main">
          <div className="led-title">
            <div>
              <p className="led-eyebrow">
                LEDGER / {String(navigation.findIndex(([id]) => id === page) + 1).padStart(2, '0')}
              </p>
              <h1>{t(page)}</h1>
              <p>{page === 'overview' ? t('welcome') : t('subtitle')}</p>
            </div>
            <div className="led-toolbar">
              {(page === 'transactions' || page === 'reports') && (
                <button onClick={exportCsv}>
                  <Download size={16} />
                  {t('export')}
                </button>
              )}
              {page === 'accounts' && !data.readOnly && (
                <button onClick={() => open({ type: 'account' })}>
                  <Plus size={16} />
                  {t('addAccount')}
                </button>
              )}
              {!data.readOnly && (
                <button className="led-primary" onClick={() => open({ type: 'entry', kind: 'expense' })}>
                  <Plus size={16} />
                  {t('newEntry')}
                </button>
              )}
            </div>
          </div>
          {content}
        </main>
      </div>
      {form && (
        <Modal
          title={
            form.type === 'entry'
              ? t('newEntry')
              : form.type === 'account'
                ? t(form.account ? 'editAccount' : 'addAccount')
                : form.type === 'reverse'
                  ? t('reverse')
                  : form.type === 'budget'
                    ? `${t('setBudget')} · ${name(form.account)}`
                    : `${t('rates')} · ${form.currency}`
          }
          onClose={() => !busy && setForm(null)}
        >
          {form.type === 'entry' && (
            <EntryForm data={data} accounts={moneyAccounts} active={active} initialKind={form.kind} locale={locale} t={t} busy={busy} error={formError} onSubmit={(input) => void run({ action: 'record', ...input })} onCancel={() => setForm(null)} />
          )}
          {form.type === 'account' && (
            <AccountForm account={form.account} used={!!form.account && data.postings.some((p) => p.account_id === form.account!.id)} t={t} busy={busy} error={formError} onSubmit={(command) => void run(command)} onCancel={() => setForm(null)} />
          )}
          {form.type === 'reverse' && (
            <ReverseForm row={view.rows.find((r) => r.entry.id === form.entry.id)!} describe={describe} t={t} busy={busy} error={formError} onSubmit={(occurredOn) => void run({ action: 'reverse', entryId: form.entry.id, occurredOn })} onCancel={() => setForm(null)} />
          )}
          {form.type === 'budget' && (
            <AmountForm label={t('budgeted')} hint={t('budgetHint')} initial={form.cents ? amountText(form.cents) : ''} allowZero t={t} busy={busy} error={formError} onSubmit={(cents) => void run({ action: 'set-budget', accountId: form.account.id, month: form.month, amountCents: cents })} onCancel={() => setForm(null)} />
          )}
          {form.type === 'rate' && (
            <RateForm currency={form.currency} rate={form.rate} t={t} busy={busy} error={formError} onSubmit={(rate) => void run({ action: 'set-rate', currency: form.currency as 'EUR' | 'GBP', rate })} onCancel={() => setForm(null)} />
          )}
        </Modal>
      )}
    </div>
  )
}

function nextMonth(month: string) {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7)
}

type T = (key: string) => string

function Panel({ title, action, className = '', children }: { title?: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`led-panel ${className}`}>
      {(title || action) && (
        <header>
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'in' | 'out' }) {
  return (
    <div className="led-kpi">
      <span>{label}</span>
      <strong className={tone ? `led-${tone}` : ''}>{value}</strong>
      {hint && <em>{hint}</em>}
    </div>
  )
}

function Meter({ ratio, empty }: { ratio: number; empty?: boolean }) {
  const level = empty ? 'empty' : ratio > 1 ? 'over' : ratio > 0.85 ? 'near' : 'ok'
  return (
    <div className={`led-meter led-meter-${level}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
      <i style={{ width: `${Math.min(100, ratio * 100)}%` }} />
    </div>
  )
}

function BudgetBars({ lines, locale, t }: { lines: ReturnType<typeof budgetProgress>; locale: Locale; t: T }) {
  if (!lines.length) return <p className="led-empty">{t('unbudgeted')}</p>
  return (
    <ul className="led-budget-list led-compact">
      {lines.map((line) => (
        <li key={line.account.id}>
          <div className="led-budget-head">
            <strong>{localized(line.account, locale)}</strong>
            <span>
              {money(line.spent, BASE_CURRENCY, locale, 'whole')}
              <em> / {money(line.budget, BASE_CURRENCY, locale, 'whole')}</em>
            </span>
          </div>
          <Meter ratio={line.spent / line.budget} />
        </li>
      ))}
    </ul>
  )
}

function CashFlowChart({ rows, locale, t }: { rows: ReturnType<typeof cashFlow>; locale: Locale; t: T }) {
  const width = 640
  const height = 220
  const pad = { top: 12, right: 8, bottom: 26, left: 56 }
  const max = Math.max(1, ...rows.flatMap((r) => [r.income, r.expense]))
  const step = niceStep(max / 3)
  const top = Math.ceil(max / step) * step
  const y = (v: number) => pad.top + (1 - v / top) * (height - pad.top - pad.bottom)
  const band = (width - pad.left - pad.right) / rows.length
  const bar = Math.min(22, band / 3.2)
  return (
    <figure className="led-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('cashFlow')}>
        {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} className="led-gridline" />
            <text x={pad.left - 8} y={y(v) + 4} textAnchor="end" className="led-axis">
              {money(v, BASE_CURRENCY, locale, 'compact')}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = pad.left + band * i + band / 2
          return (
            <g key={r.month}>
              <rect x={x - bar - 2} y={y(r.income)} width={bar} height={y(0) - y(r.income)} rx={3} className="led-bar-in">
                <title>{`${t('income')} ${money(r.income, BASE_CURRENCY, locale)}`}</title>
              </rect>
              <rect x={x + 2} y={y(r.expense)} width={bar} height={y(0) - y(r.expense)} rx={3} className="led-bar-out">
                <title>{`${t('spending')} ${money(r.expense, BASE_CURRENCY, locale)}`}</title>
              </rect>
              <text x={x} y={height - 6} textAnchor="middle" className="led-axis">
                {monthLabel(r.month, locale)}
              </text>
            </g>
          )
        })}
      </svg>
      <figcaption>
        <span className="led-key led-key-in" />
        {t('income')}
        <span className="led-key led-key-out" />
        {t('spending')}
      </figcaption>
    </figure>
  )
}

function NetWorthChart({ points, locale }: { points: ReturnType<typeof netWorthSeries>; locale: Locale }) {
  const width = 320
  const height = 180
  const pad = { top: 16, right: 12, bottom: 24, left: 12 }
  const values = points.map((p) => p.cents)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const x = (i: number) => pad.left + (i / Math.max(1, points.length - 1)) * (width - pad.left - pad.right)
  const y = (v: number) => pad.top + (1 - (v - min) / span) * (height - pad.top - pad.bottom)
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.cents).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  return (
    <figure className="led-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={last ? money(last.cents, BASE_CURRENCY, locale) : ''}>
        <path d={`${line} L${x(points.length - 1)} ${height - pad.bottom} L${x(0)} ${height - pad.bottom} Z`} className="led-area" />
        <path d={line} className="led-line" />
        {points.map((p, i) => (
          <g key={p.month}>
            <circle cx={x(i)} cy={y(p.cents)} r={3} className="led-point">
              <title>{`${monthLabel(p.month, locale)} ${money(p.cents, BASE_CURRENCY, locale)}`}</title>
            </circle>
            <text x={x(i)} y={height - 6} textAnchor="middle" className="led-axis">
              {monthLabel(p.month, locale)}
            </text>
          </g>
        ))}
      </svg>
      {last && <p className="led-figure">{money(last.cents, BASE_CURRENCY, locale)}</p>}
    </figure>
  )
}

function niceStep(raw: number) {
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1)))
  return ([1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? power * 10)
}

function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <Select value={value} onValueChange={(next) => next !== null && onChange(next as string)}>
      <SelectTrigger aria-label={label} className="led-select">
        <SelectValue>{(v) => options.find(([id]) => id === v)?.[1] ?? ''}</SelectValue>
      </SelectTrigger>
      <SelectContent className="led-select-popup" positionerClassName="led-select-positioner">
        {options.map(([id, text]) => (
          <SelectItem key={id || 'all'} value={id}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="led-modal-backdrop" />
        <Dialog.Popup className="ledger-app led-modal">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close className="led-icon led-modal-close" aria-label="Close">
            <X size={18} />
          </Dialog.Close>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="led-field">
      <span>{label}</span>
      {children}
      {hint && <em>{hint}</em>}
    </label>
  )
}

function Actions({ t, busy, error, onCancel }: { t: T; busy: boolean; error: string; onCancel: () => void }) {
  return (
    <>
      {error && <p className="led-error">{t(error)}</p>}
      <div className="led-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </button>
        <button type="submit" className="led-primary" disabled={busy}>
          {busy ? t('saving') : t('save')}
        </button>
      </div>
    </>
  )
}

function EntryForm({
  data,
  accounts,
  active,
  initialKind,
  locale,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  data: LedgerData
  accounts: Account[]
  active: Account[]
  initialKind: RecordInput['kind']
  locale: Locale
  t: T
  busy: boolean
  error: string
  onSubmit: (input: RecordInput) => void
  onCancel: () => void
}) {
  const [kind, setKind] = useState(initialKind)
  const pick = (k: AccountKind) => active.filter((a) => a.kind === k)
  const sources = kind === 'income' ? pick('income') : accounts
  const targets = kind === 'expense' ? pick('expense') : accounts
  const [fromId, setFromId] = useState(sources[0]?.id ?? '')
  const [toId, setToId] = useState(targets[kind === 'transfer' ? 1 : 0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [arrived, setArrived] = useState('')
  const [occurredOn, setOccurredOn] = useState(today())
  const [payee, setPayee] = useState('')
  const [memo, setMemo] = useState('')
  const [local, setLocal] = useState('')
  const switchKind = (next: RecordInput['kind']) => {
    setKind(next)
    const s = next === 'income' ? pick('income') : accounts
    const d = next === 'expense' ? pick('expense') : accounts
    setFromId(s[0]?.id ?? '')
    setToId(d[next === 'transfer' ? 1 : 0]?.id ?? '')
    setLocal('')
  }
  const from = active.find((a) => a.id === fromId)
  const to = active.find((a) => a.id === toId)
  const crossCurrency = kind === 'transfer' && from && to && from.currency !== to.currency
  const input: RecordInput = {
    kind,
    occurredOn,
    payee: payee.trim(),
    memo: memo.trim(),
    fromAccountId: fromId,
    toAccountId: toId,
    amountCents: parseAmount(amount) ?? 0,
    ...(crossCurrency ? { toAmountCents: parseAmount(arrived) ?? 0 } : {}),
  }
  let preview = ''
  try {
    const legs = planEntry(input, data.accounts, data.fx_rates)
    const foreign = (kind === 'income' ? to : from)?.currency
    if (!crossCurrency && foreign && foreign !== BASE_CURRENCY)
      preview = `${t('booksAs')} ${money(legs[1].base_cents, BASE_CURRENCY, locale)} · ${t('atRate')} ${rateOf(data.fx_rates, foreign).toFixed(4)}`
  } catch {}
  const submit = (e: FormEvent) => {
    e.preventDefault()
    try {
      planEntry(input, data.accounts, data.fx_rates)
      setLocal('')
      onSubmit(input)
    } catch (err) {
      setLocal(err instanceof Error ? err.message : 'generic_error')
    }
  }
  const options = (list: Account[]) => list.map((a): [string, string] => [a.id, `${localized(a, locale)}${isMoney(a) && a.currency !== BASE_CURRENCY ? ` · ${a.currency}` : ''}`])
  return (
    <form onSubmit={submit} className="led-form">
      <div className="led-segments" role="tablist">
        {(['expense', 'income', 'transfer'] as const).map((k) => (
          <button type="button" role="tab" key={k} aria-selected={kind === k} onClick={() => switchKind(k)}>
            {k === 'transfer' && <ArrowLeftRight size={14} />}
            {t(k)}
          </button>
        ))}
      </div>
      <div className="led-form-row">
        <Field label={kind === 'income' ? t('source') : kind === 'expense' ? t('paidFrom') : t('from')}>
          <Choice label={t('from')} value={fromId} onChange={setFromId} options={options(sources)} />
        </Field>
        <Field label={kind === 'expense' ? t('category') : kind === 'income' ? t('depositTo') : t('to')}>
          <Choice label={t('to')} value={toId} onChange={setToId} options={options(targets)} />
        </Field>
      </div>
      <div className="led-form-row">
        <Field label={`${t('amount')}${from && kind !== 'income' ? ` · ${from.currency}` : to ? ` · ${to.currency}` : ''}`} hint={preview}>
          <input inputMode="decimal" autoFocus required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </Field>
        {crossCurrency ? (
          <Field label={`${t('arrived')} · ${to!.currency}`}>
            <input inputMode="decimal" required value={arrived} onChange={(e) => setArrived(e.target.value)} placeholder="0.00" />
          </Field>
        ) : (
          <Field label={t('date')}>
            <input type="date" required value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
          </Field>
        )}
      </div>
      {crossCurrency && (
        <Field label={t('date')}>
          <input type="date" required value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
        </Field>
      )}
      <div className="led-form-row">
        <Field label={t('payee')}>
          <input value={payee} maxLength={160} onChange={(e) => setPayee(e.target.value)} />
        </Field>
        <Field label={t('memo')}>
          <input value={memo} maxLength={500} onChange={(e) => setMemo(e.target.value)} />
        </Field>
      </div>
      <Actions t={t} busy={busy} error={local || error} onCancel={onCancel} />
    </form>
  )
}

function AccountForm({
  account,
  used,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  account?: Account
  used: boolean
  t: T
  busy: boolean
  error: string
  onSubmit: (command: Command) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(account?.name ?? '')
  const [nameEn, setNameEn] = useState(account?.name_en ?? '')
  const [kind, setKind] = useState<AccountKind>(account?.kind ?? 'asset')
  const [currency, setCurrency] = useState<Currency>(account?.currency ?? BASE_CURRENCY)
  const [archived, setArchived] = useState(account?.archived ?? false)
  const [opening, setOpening] = useState('')
  const [openedOn, setOpenedOn] = useState(today())
  const [local, setLocal] = useState('')
  const locked = !!account && used
  const holdsMoney = kind === 'asset' || kind === 'liability'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const cents = opening.trim() ? parseAmount(opening) : 0
    if (cents === null) return setLocal('invalid_amount')
    setLocal('')
    onSubmit({
      action: 'save-account',
      ...(account ? { id: account.id } : {}),
      name: name.trim(),
      name_en: nameEn.trim(),
      kind: kind as 'asset',
      currency: holdsMoney ? currency : BASE_CURRENCY,
      archived,
      ...(!account && holdsMoney && cents ? { openingCents: kind === 'liability' ? -cents : cents, openedOn } : {}),
    })
  }
  return (
    <form onSubmit={submit} className="led-form">
      <div className="led-form-row">
        <Field label={t('name')}>
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label={t('nameEn')}>
          <input maxLength={80} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </Field>
      </div>
      <div className="led-form-row">
        <Field label={t('kind')} hint={locked ? t('lockedHint') : undefined}>
          {locked || account?.kind === 'equity' ? (
            <input disabled value={t(kind === 'income' ? 'incomeKind' : kind === 'expense' ? 'expenseKind' : kind)} />
          ) : (
            <Choice
              label={t('kind')}
              value={kind}
              onChange={(v) => setKind(v as AccountKind)}
              options={(['asset', 'liability', 'income', 'expense'] as const).map((k): [string, string] => [k, t(k === 'income' ? 'incomeKind' : k === 'expense' ? 'expenseKind' : k)])}
            />
          )}
        </Field>
        <Field label={t('currency')}>
          {locked || !holdsMoney ? (
            <input disabled value={holdsMoney ? currency : BASE_CURRENCY} />
          ) : (
            <Choice label={t('currency')} value={currency} onChange={(v) => setCurrency(v as Currency)} options={currencies.map((c): [string, string] => [c, c])} />
          )}
        </Field>
      </div>
      {!account && holdsMoney && (
        <div className="led-form-row">
          <Field label={t('openingBalance')} hint={kind === 'liability' ? t('openingHint') : undefined}>
            <input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label={t('openedOn')}>
            <input type="date" value={openedOn} onChange={(e) => setOpenedOn(e.target.value)} />
          </Field>
        </div>
      )}
      {account && (
        <label className="led-check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          {t('archive')}
        </label>
      )}
      <Actions t={t} busy={busy} error={local || error} onCancel={onCancel} />
    </form>
  )
}

function ReverseForm({
  row,
  describe,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  row: Row
  describe: (row: Row) => { title: string; route: string; amount: string }
  t: T
  busy: boolean
  error: string
  onSubmit: (occurredOn: string) => void
  onCancel: () => void
}) {
  const [occurredOn, setOccurredOn] = useState(today())
  const d = describe(row)
  return (
    <form
      className="led-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(occurredOn)
      }}
    >
      <p className="led-muted">{t('reverseConfirm')}</p>
      <div className="led-quote">
        <strong>{d.title}</strong>
        <span>{d.route}</span>
        <span className="led-amount">{d.amount}</span>
      </div>
      <Field label={t('date')}>
        <input type="date" required value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
      </Field>
      <Actions t={t} busy={busy} error={error} onCancel={onCancel} />
    </form>
  )
}

function AmountForm({
  label,
  hint,
  initial,
  allowZero,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  label: string
  hint?: string
  initial: string
  allowZero?: boolean
  t: T
  busy: boolean
  error: string
  onSubmit: (cents: number) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const [local, setLocal] = useState('')
  return (
    <form
      className="led-form"
      onSubmit={(e) => {
        e.preventDefault()
        const cents = parseAmount(value || '0')
        if (cents === null || (!allowZero && cents === 0)) return setLocal('invalid_amount')
        setLocal('')
        onSubmit(cents)
      }}
    >
      <Field label={`${label} · ${BASE_CURRENCY}`} hint={hint}>
        <input inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.00" />
      </Field>
      <Actions t={t} busy={busy} error={local || error} onCancel={onCancel} />
    </form>
  )
}

function RateForm({
  currency,
  rate,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  currency: Currency
  rate: number
  t: T
  busy: boolean
  error: string
  onSubmit: (rate: number) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(rate ? String(rate) : '')
  const [local, setLocal] = useState('')
  return (
    <form
      className="led-form"
      onSubmit={(e) => {
        e.preventDefault()
        const next = Number(value)
        if (!/^\d+(\.\d{1,6})?$/.test(value.trim()) || !(next > 0) || next > 10_000) return setLocal('invalid_amount')
        setLocal('')
        onSubmit(next)
      }}
    >
      <Field label={`1 ${currency} = ? ${BASE_CURRENCY}`} hint={t('ratesHint')}>
        <input inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <Actions t={t} busy={busy} error={local || error} onCancel={onCancel} />
    </form>
  )
}
