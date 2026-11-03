import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import {
  ArrowRight,
  Building2,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Globe,
  LayoutDashboard,
  List,
  Mail,
  MessageSquareText,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Search,
  StickyNote,
  Users,
  X,
} from 'lucide-react'
import {
  activityKinds,
  addDays,
  daysInStage,
  forecast,
  historyOf,
  industries,
  isClosed,
  lastMonths,
  lostReasons,
  matchesDeal,
  money,
  monthOf,
  neighbourStage,
  openStages,
  parseAmount,
  pipelineByStage,
  sortDeals,
  stageProbability,
  stages,
  upcomingTasks,
  validateCompany,
  validateContact,
  validateDeal,
  weighted,
  winRate,
  wonByMonth,
  type Activity,
  type ActivityKind,
  type Company,
  type CompanyInput,
  type Contact,
  type ContactInput,
  type CrmAction,
  type CrmData,
  type CrmProps,
  type Deal,
  type DealInput,
  type Locale,
  type Stage,
} from '@lovbase/core/crm'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { errorKey, translate } from './labels'
import './crm.css'

type Page = 'dashboard' | 'pipeline' | 'deals' | 'companies'
type Form =
  | { type: 'deal'; deal?: Deal; companyId?: string; stage?: Stage }
  | { type: 'company'; company?: Company }
  | { type: 'contact'; contact?: Contact; companyId: string }
  | { type: 'lost'; deal: Deal }
type T = (key: string) => string

const navigation: [Page, typeof Users][] = [
  ['dashboard', LayoutDashboard],
  ['pipeline', Columns3],
  ['deals', List],
  ['companies', Building2],
]
const kindIcon: Record<ActivityKind, typeof Users> = {
  call: Phone,
  email: Mail,
  meeting: Users,
  note: StickyNote,
  task: CalendarClock,
}
const kindLabel = (kind: ActivityKind) => (kind === 'email' ? 'email_kind' : kind)
/** How many won or lost deals a board column shows before pointing at the full list. */
const CLOSED_ON_BOARD = 5
const localToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const intl = (locale: Locale) => (locale === 'zh' ? 'zh-CN' : 'en-US')
function dayLabel(day: string, locale: Locale, withYear = false) {
  const [y, m, d] = day.split('-').map(Number)
  return new Intl.DateTimeFormat(intl(locale), {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)))
}
function monthLabel(month: string, locale: Locale) {
  const [y, m] = month.split('-').map(Number)
  return new Intl.DateTimeFormat(intl(locale), { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))
}
function momentLabel(iso: string, locale: Locale) {
  return new Intl.DateTimeFormat(intl(locale), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}
/** People go by their given name (the last two characters in Chinese); companies by their brand. */
const initials = (name: string, kind: 'person' | 'company' = 'person') =>
  /[一-鿿]/.test(name)
    ? kind === 'person'
      ? name.slice(-2)
      : name.slice(0, 2)
    : name
        .split(/\s+/)
        .filter((part) => /^[a-z]/i.test(part))
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()

export function CrmApp({ client, initialLocale = 'en', locale: controlledLocale, onLocaleChange, initialData }: CrmProps) {
  const [localLocale, setLocalLocale] = useState<Locale>(initialLocale)
  const locale = controlledLocale ?? localLocale
  const t: T = (key) => translate(locale, key)
  const [data, setData] = useState<CrmData | null>(initialData ?? null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(!initialData)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [page, setPage] = useState<Page>('dashboard')
  const [form, setForm] = useState<Form | null>(null)
  const [dealId, setDealId] = useState<string | null>(null)
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [stageFilter, setStageFilter] = useState('open')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [companyQuery, setCompanyQuery] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<Stage | null>(null)

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

  /**
   * Every write is one statement; the database does the follow-on bookkeeping, so the app just
   * reads again afterwards. A stage move is shown at once and rolled back if the write fails.
   */
  const run = async (action: CrmAction, after?: () => void) => {
    if (busy || !data || data.readOnly) return false
    setBusy(true)
    setFormError('')
    const before = data
    if (action.action === 'move-deal')
      setData({ ...data, deals: data.deals.map((d) => (d.id === action.id ? { ...d, stage: action.to } : d)) })
    try {
      await client.run(action)
      setData(await client.read())
      setForm(null)
      after?.()
      return true
    } catch (e) {
      if (action.action === 'move-deal') setData(before)
      const key = errorKey(e instanceof Error ? e.message : '')
      setFormError(key)
      if (!form && !dealId) setError(key)
      return false
    } finally {
      setBusy(false)
    }
  }
  const open = (next: Form) => {
    setFormError('')
    setForm(next)
  }
  const move = (deal: Deal, to: Stage) => {
    if (to === deal.stage || data?.readOnly) return
    if (to === 'lost') return open({ type: 'lost', deal })
    void run({ action: 'move-deal', id: deal.id, from: deal.stage, to })
  }

  const view = useMemo(() => {
    if (!data) return null
    // A real pipeline lives in today. The read-only demo was seeded once, so it is shown as of its
    // latest recorded moment; otherwise every expected close would slide into the past.
    const latest = data.readOnly
      ? [...data.deal_stage_history.map((h) => h.changed_at), ...data.activities.map((a) => a.created_at)].sort().pop()
      : undefined
    const now = latest ? new Date(latest) : new Date()
    const today = latest ? latest.slice(0, 10) : localToday()
    return {
      now,
      today,
      companies: new Map(data.companies.map((c) => [c.id, c])),
      contacts: new Map(data.contacts.map((c) => [c.id, c])),
      owners: [...new Set(data.deals.map((d) => d.owner).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    }
  }, [data])

  if (!data || !view)
    return (
      <div className="crm-app crm-center">
        {error ? (
          <div>
            <p>{t(error)}</p>
            <button onClick={() => void read()}>{t('retry')}</button>
          </div>
        ) : (
          <p className="crm-muted">{loading ? t('loading') : ''}</p>
        )}
      </div>
    )

  const writable = !data.readOnly
  const companyName = (id: string) => view.companies.get(id)?.name ?? '—'
  const stageText = (stage: Stage) => t(stage)
  const dealsText = (n: number) => (locale === 'zh' ? `${n} 个商机` : `${n} ${n === 1 ? 'deal' : 'deals'}`)
  const dueText = (day: string) =>
    day < view.today ? `${t('overdue')} · ${dayLabel(day, locale)}` : day === view.today ? t('dueToday') : dayLabel(day, locale)
  const openDeal = (deal: Deal) => {
    setFormError('')
    setDealId(deal.id)
  }
  const goTo = (next: Page) => {
    setPage(next)
    setError('')
  }

  // ── Dashboard ──
  const pipe = forecast(data.deals)
  const since = addDays(view.today, -90)
  const rate = winRate(data.deals, since)
  const closedRecently = data.deals.filter((d) => isClosed(d.stage) && d.closed_on && d.closed_on >= since)
  const months = lastMonths(monthOf(view.today), 6)
  const wins = wonByMonth(data.deals, months)
  const thisMonth = wins[wins.length - 1]
  const tasks = upcomingTasks(data.activities, view.today, 14).filter((a) => {
    const deal = data.deals.find((d) => d.id === a.deal_id)
    return deal && !isClosed(deal.stage)
  })
  const closing = sortDeals(data.deals.filter((d) => !isClosed(d.stage) && d.expected_close && d.expected_close <= addDays(view.today, 30)))
  const openDeals = data.deals.filter((d) => !isClosed(d.stage))
  const ageOf = (d: Deal) => Math.max(0, Math.floor((view.now.getTime() - new Date(d.created_at).getTime()) / 86_400_000))
  const overdueDeals = openDeals.filter((d) => d.expected_close && d.expected_close < view.today).length
  const recentMoves = [...data.deal_stage_history]
    .filter((h) => h.from_stage)
    .sort((a, b) => b.changed_at.localeCompare(a.changed_at))
    .slice(0, 6)
  const taskRow = (task: Activity, showDeal = true) => {
    const deal = data.deals.find((d) => d.id === task.deal_id)
    return (
      <li key={task.id} className={`crm-task${task.done ? ' is-done' : ''}`}>
        <TaskCheck task={task} writable={writable} busy={busy} t={t} onToggle={(done) => void run({ action: 'set-activity-done', id: task.id, done })} />
        <div className="crm-task-main">
          <strong>{task.body}</strong>
          {showDeal && deal && (
            <button className="crm-link" onClick={() => openDeal(deal)}>
              {deal.title} · {companyName(deal.company_id)}
            </button>
          )}
        </div>
        {task.due_on && <span className={`crm-due${task.due_on < view.today && !task.done ? ' is-late' : ''}`}>{dueText(task.due_on)}</span>}
      </li>
    )
  }
  const dashboard = (
    <>
      <section className="crm-kpis">
        <Kpi label={t('openPipeline')} value={money(pipe.amount, locale)} hint={dealsText(pipe.count)} />
        <Kpi label={t('weightedForecast')} value={money(pipe.weighted, locale)} hint={t('weightedHint')} tone="accent" />
        <Kpi
          label={`${t('winRate')} · ${t('last90')}`}
          value={rate === null ? '—' : `${Math.round(rate * 100)}%`}
          hint={rate === null ? t('noneClosed') : `${closedRecently.filter((d) => d.stage === 'won').length} / ${closedRecently.length} ${t('closedCount')}`}
        />
        <Kpi label={t('wonThisMonth')} value={money(thisMonth.amount, locale)} hint={dealsText(thisMonth.count)} tone="won" />
      </section>
      <div className="crm-grid">
        <Panel title={t('byStage')} className="crm-span-2" action={<button className="crm-link" onClick={() => goTo('pipeline')}>{t('pipeline')} <ArrowRight size={13} /></button>}>
          <StageBars totals={pipelineByStage(data.deals).filter((s) => !isClosed(s.stage))} locale={locale} t={t} />
          <dl className="crm-summary">
            {fact(t('avgDeal'), money(openDeals.length ? pipe.amount / openDeals.length : 0, locale))}
            {fact(t('avgAge'), `${openDeals.length ? Math.round(openDeals.reduce((sum, d) => sum + ageOf(d), 0) / openDeals.length) : 0} ${t('days')}`)}
            {fact(t('next30'), money(closing.filter((d) => d.expected_close! >= view.today).reduce((sum, d) => sum + d.amount_cents, 0), locale))}
            {fact(t('overdueDeals'), <span className={overdueDeals ? 'is-late' : ''}>{overdueDeals}</span>)}
          </dl>
        </Panel>
        <Panel title={t('upcoming')}>
          {tasks.length ? <ul className="crm-tasks">{tasks.slice(0, 6).map((task) => taskRow(task))}</ul> : <p className="crm-empty">{t('noTasks')}</p>}
        </Panel>
        <Panel title={t('wonPerMonth')} className="crm-span-2">
          <WonChart rows={wins} locale={locale} t={t} />
        </Panel>
        <Panel title={t('closingSoon')}>
          {closing.length ? (
            <ul className="crm-mini-deals">
              {closing.slice(0, 6).map((deal) => (
                <li key={deal.id}>
                  <button onClick={() => openDeal(deal)}>
                    <span className="crm-mini-main">
                      <strong>{deal.title}</strong>
                      <span>
                        {companyName(deal.company_id)} · <em className={deal.expected_close! < view.today ? 'is-late' : ''}>{dueText(deal.expected_close!)}</em>
                      </span>
                    </span>
                    <span className="crm-mini-figure">
                      <strong>{money(deal.amount_cents, locale)}</strong>
                      <StageChip stage={deal.stage} t={t} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="crm-empty">{t('noClosing')}</p>
          )}
        </Panel>
        <Panel title={t('movement')} className="crm-span-3">
          <ul className="crm-moves">
            {recentMoves.map((h) => {
              const deal = data.deals.find((d) => d.id === h.deal_id)
              if (!deal) return null
              return (
                <li key={h.id}>
                  <time>{momentLabel(h.changed_at, locale)}</time>
                  <span className="crm-move-deal">
                    <button className="crm-link" onClick={() => openDeal(deal)}>
                      {deal.title}
                    </button>
                    <span className="crm-muted">{companyName(deal.company_id)}</span>
                  </span>
                  <span className="crm-move">
                    <StageChip stage={h.from_stage!} t={t} muted />
                    <ArrowRight size={13} />
                    <StageChip stage={h.to_stage} t={t} />
                  </span>
                </li>
              )
            })}
          </ul>
        </Panel>
      </div>
    </>
  )

  // ── Pipeline board ──
  const boardDeals = data.deals.filter((d) => (!ownerFilter || d.owner === ownerFilter) && matchesDeal(d, view.companies.get(d.company_id), query))
  const totals = pipelineByStage(boardDeals)
  const onDrop = (stage: Stage) => (e: DragEvent) => {
    e.preventDefault()
    const deal = data.deals.find((d) => d.id === (e.dataTransfer.getData('text/plain') || dragging))
    setDragging(null)
    setDropTarget(null)
    if (deal) move(deal, stage)
  }
  const card = (deal: Deal) => {
    const back = neighbourStage(deal.stage, -1)
    const forward = neighbourStage(deal.stage, 1)
    const late = !isClosed(deal.stage) && deal.expected_close && deal.expected_close < view.today
    return (
      <li
        key={deal.id}
        className={`crm-card${dragging === deal.id ? ' is-dragging' : ''}`}
        draggable={writable && !busy}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', deal.id)
          e.dataTransfer.effectAllowed = 'move'
          setDragging(deal.id)
        }}
        onDragEnd={() => {
          setDragging(null)
          setDropTarget(null)
        }}
      >
        <button className="crm-card-open" onClick={() => openDeal(deal)}>
          <span className="crm-card-company">{companyName(deal.company_id)}</span>
          <strong>{deal.title}</strong>
          <span className="crm-card-figures">
            <b>{money(deal.amount_cents, locale)}</b>
            {!isClosed(deal.stage) && <em>{deal.probability}%</em>}
          </span>
        </button>
        <div className="crm-card-foot">
          <span className="crm-avatar" title={deal.owner}>
            {initials(deal.owner)}
          </span>
          <span className={`crm-card-date${late ? ' is-late' : ''}`}>
            {isClosed(deal.stage)
              ? deal.closed_on && dayLabel(deal.closed_on, locale)
              : deal.expected_close
                ? dayLabel(deal.expected_close, locale)
                : `${daysInStage(deal, data.deal_stage_history, view.now)} ${t('days')}`}
          </span>
          {writable && (
            <span className="crm-steps">
              {back && (
                <button className="crm-icon" disabled={busy} aria-label={`${t('moveTo')} ${stageText(back)}`} title={`${t('moveTo')} ${stageText(back)}`} onClick={() => move(deal, back)}>
                  <ChevronLeft size={15} />
                </button>
              )}
              {forward && (
                <button className="crm-icon" disabled={busy} aria-label={`${t('moveTo')} ${stageText(forward)}`} title={`${t('moveTo')} ${stageText(forward)}`} onClick={() => move(deal, forward)}>
                  <ChevronRight size={15} />
                </button>
              )}
            </span>
          )}
        </div>
      </li>
    )
  }
  const pipeline = (
    <>
      <div className="crm-filters">
        <SearchBox value={query} onChange={setQuery} placeholder={t('search')} />
        <Choice label={t('owner')} value={ownerFilter} onChange={setOwnerFilter} options={[['', t('allOwners')], ...view.owners.map((o): [string, string] => [o, o])]} />
      </div>
      <div className="crm-board">
        {stages.map((stage) => {
          const total = totals.find((s) => s.stage === stage)!
          const list = sortDeals(boardDeals.filter((d) => d.stage === stage))
          const shown = isClosed(stage) ? list.slice(0, CLOSED_ON_BOARD) : list
          return (
            <section
              key={stage}
              aria-label={stageText(stage)}
              className={`crm-column crm-stage-${stage}${dropTarget === stage ? ' is-target' : ''}`}
              onDragOver={(e) => {
                if (!dragging) return
                e.preventDefault()
                setDropTarget(stage)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null)
              }}
              onDrop={onDrop(stage)}
            >
              <header>
                <div className="crm-column-title">
                  <i className="crm-dot" />
                  <h2>{stageText(stage)}</h2>
                  <span className="crm-count">{total.count}</span>
                </div>
                <strong>{money(total.amount, locale)}</strong>
                <span className="crm-muted">
                  {isClosed(stage) ? t('latestFirst') : `${t('weighted')} ${money(total.weighted, locale)}`}
                </span>
              </header>
              <ul>{shown.map(card)}</ul>
              {list.length > shown.length && (
                <button
                  className="crm-link crm-more"
                  onClick={() => {
                    setStageFilter(stage)
                    goTo('deals')
                  }}
                >
                  +{list.length - shown.length} {t('more')}
                </button>
              )}
              {dragging && !list.length && <p className="crm-drop">{t('dropHere')}</p>}
            </section>
          )
        })}
      </div>
    </>
  )

  // ── Deals list ──
  const listed = sortDeals(
    data.deals.filter(
      (d) =>
        (stageFilter === '' || (stageFilter === 'open' ? !isClosed(d.stage) : d.stage === stageFilter)) &&
        (!ownerFilter || d.owner === ownerFilter) &&
        matchesDeal(d, view.companies.get(d.company_id), query),
    ),
  )
  const listedTotal = listed.reduce((sum, d) => sum + d.amount_cents, 0)
  const deals = (
    <Panel>
      <div className="crm-filters">
        <SearchBox value={query} onChange={setQuery} placeholder={t('search')} />
        <Choice
          label={t('stage')}
          value={stageFilter}
          onChange={setStageFilter}
          options={[['open', t('openOnly')], ['', t('allStages')], ...stages.map((s): [string, string] => [s, stageText(s)])]}
        />
        <Choice label={t('owner')} value={ownerFilter} onChange={setOwnerFilter} options={[['', t('allOwners')], ...view.owners.map((o): [string, string] => [o, o])]} />
        <span className="crm-filter-total">
          {dealsText(listed.length)} · <strong>{money(listedTotal, locale)}</strong>
        </span>
      </div>
      {listed.length === 0 ? (
        <p className="crm-empty">{t('noDeals')}</p>
      ) : (
        <div className="crm-table-scroll">
          <table className="crm-table">
            <thead>
              <tr>
                <th>{t('deal')}</th>
                <th>{t('stage')}</th>
                <th className="crm-num">{t('amount')}</th>
                <th className="crm-num crm-wide">{t('probability')}</th>
                <th className="crm-num crm-wide">{t('weighted')}</th>
                <th>{t('expectedClose')}</th>
                <th className="crm-wide">{t('owner')}</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((deal) => (
                <tr key={deal.id}>
                  <td>
                    <button className="crm-row-title" onClick={() => openDeal(deal)}>
                      <strong>{deal.title}</strong>
                      <span>{companyName(deal.company_id)}</span>
                    </button>
                  </td>
                  <td>
                    <StageChip stage={deal.stage} t={t} />
                  </td>
                  <td className="crm-num">{money(deal.amount_cents, locale)}</td>
                  <td className="crm-num crm-wide">{deal.probability}%</td>
                  <td className="crm-num crm-wide">{money(weighted(deal), locale)}</td>
                  <td className={!isClosed(deal.stage) && deal.expected_close && deal.expected_close < view.today ? 'is-late' : ''}>
                    {isClosed(deal.stage)
                      ? deal.closed_on && dayLabel(deal.closed_on, locale)
                      : deal.expected_close
                        ? dayLabel(deal.expected_close, locale)
                        : '—'}
                  </td>
                  <td className="crm-wide">
                    <span className="crm-owner">
                      <span className="crm-avatar">{initials(deal.owner)}</span>
                      {deal.owner}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )

  // ── Companies ──
  const companyStats = (id: string) => {
    const list = data.deals.filter((d) => d.company_id === id)
    return {
      deals: list,
      open: list.filter((d) => !isClosed(d.stage)).reduce((sum, d) => sum + d.amount_cents, 0),
      won: list.filter((d) => d.stage === 'won').reduce((sum, d) => sum + d.amount_cents, 0),
    }
  }
  const companyList = [...data.companies]
    .filter((c) => `${c.name} ${c.city} ${t(c.industry)}`.toLowerCase().includes(companyQuery.trim().toLowerCase()))
    .sort((a, b) => companyStats(b.id).open - companyStats(a.id).open || a.name.localeCompare(b.name))
  const selected = view.companies.get(companyId ?? '') ?? companyList[0]
  const companies = (
    <div className="crm-directory">
      <Panel className="crm-company-list">
        <SearchBox value={companyQuery} onChange={setCompanyQuery} placeholder={t('searchCompanies')} />
        {companyList.length === 0 && <p className="crm-empty">{t('noCompanies')}</p>}
        <ul>
          {companyList.map((c) => {
            const stats = companyStats(c.id)
            return (
              <li key={c.id}>
                <button aria-current={selected?.id === c.id ? 'true' : undefined} onClick={() => setCompanyId(c.id)}>
                  <span className="crm-logo">{initials(c.name, 'company')}</span>
                  <span className="crm-company-main">
                    <strong>{c.name}</strong>
                    <span>{[t(c.industry), c.city].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="crm-company-figure">
                    <strong>{stats.open ? money(stats.open, locale, 'compact') : '—'}</strong>
                    <span>{dealsText(stats.deals.length)}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </Panel>
      {selected && (
        <CompanyDetail
          company={selected}
          contacts={data.contacts.filter((c) => c.company_id === selected.id)}
          deals={sortDeals(companyStats(selected.id).deals)}
          stats={companyStats(selected.id)}
          writable={writable}
          locale={locale}
          t={t}
          onEdit={() => open({ type: 'company', company: selected })}
          onAddContact={() => open({ type: 'contact', companyId: selected.id })}
          onEditContact={(contact) => open({ type: 'contact', contact, companyId: selected.id })}
          onAddDeal={() => open({ type: 'deal', companyId: selected.id })}
          onOpenDeal={openDeal}
        />
      )}
    </div>
  )

  const content = { dashboard, pipeline, deals, companies }[page]
  const drawerDeal = data.deals.find((d) => d.id === dealId)
  return (
    <div className="crm-app">
      <header className="crm-header">
        <div className="crm-brand">
          <span className="crm-mark" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          {t('brand')}
        </div>
        <nav className="crm-nav">
          {navigation.map(([id, Icon]) => (
            <button key={id} aria-current={page === id ? 'page' : undefined} onClick={() => goTo(id)}>
              <Icon size={16} />
              <span>{t(id)}</span>
            </button>
          ))}
        </nav>
        <div className="crm-toolbar">
          <div className="crm-language" aria-label={t('language')}>
            {(['zh', 'en'] as const).map((l) => (
              <button key={l} aria-pressed={locale === l} onClick={() => switchLocale(l)}>
                {l === 'zh' ? '中文' : 'EN'}
              </button>
            ))}
          </div>
          <button className="crm-icon" aria-label={t('refresh')} title={t('refresh')} disabled={loading} onClick={() => void read()}>
            <RefreshCw size={16} />
          </button>
        </div>
      </header>
      {data.readOnly && (
        <div className="crm-demo">
          <span className="crm-pulse" />
          {t('readonly')}
        </div>
      )}
      <main className="crm-main">
        <div className="crm-title">
          <div>
            <h1>{t(page === 'pipeline' ? 'pipeline' : page)}</h1>
            <p>{t(`${page}Intro`)}</p>
          </div>
          {writable && (
            <div className="crm-toolbar">
              {page === 'companies' && (
                <button onClick={() => open({ type: 'company' })}>
                  <Plus size={16} />
                  {t('newCompany')}
                </button>
              )}
              <button className="crm-primary" onClick={() => open({ type: 'deal', companyId: page === 'companies' ? selected?.id : undefined })}>
                <Plus size={16} />
                {t('newDeal')}
              </button>
            </div>
          )}
        </div>
        {error && !form && (
          <p className="crm-banner" role="alert">
            {t(error)}
            <button className="crm-icon" aria-label={t('close')} onClick={() => setError('')}>
              <X size={14} />
            </button>
          </p>
        )}
        {content}
      </main>
      {drawerDeal && !form && (
        <DealDrawer
          deal={drawerDeal}
          data={data}
          company={view.companies.get(drawerDeal.company_id)}
          contact={drawerDeal.contact_id ? view.contacts.get(drawerDeal.contact_id) : undefined}
          now={view.now}
          today={view.today}
          writable={writable}
          busy={busy}
          error={formError}
          locale={locale}
          t={t}
          onClose={() => setDealId(null)}
          onMove={(to) => move(drawerDeal, to)}
          onEdit={() => open({ type: 'deal', deal: drawerDeal })}
          onRun={(action, after) => run(action, after)}
        />
      )}
      {form && (
        <Modal
          title={
            form.type === 'deal'
              ? t(form.deal ? 'editDeal' : 'newDeal')
              : form.type === 'company'
                ? t(form.company ? 'editCompany' : 'newCompany')
                : form.type === 'contact'
                  ? t(form.contact ? 'editContact' : 'newContact')
                  : `${t('lostTitle')} · ${form.deal.title}`
          }
          closeLabel={t('close')}
          onClose={() => !busy && setForm(null)}
        >
          {form.type === 'deal' && (
            <DealForm
              deal={form.deal}
              companyId={form.companyId}
              data={data}
              owners={view.owners}
              t={t}
              busy={busy}
              error={formError}
              onCancel={() => setForm(null)}
              onSubmit={(input) =>
                void run(form.deal ? { action: 'update-deal', id: form.deal.id, ...input } : { action: 'create-deal', stage: 'lead', ...input })
              }
            />
          )}
          {form.type === 'company' && (
            <CompanyForm
              company={form.company}
              t={t}
              busy={busy}
              error={formError}
              onCancel={() => setForm(null)}
              onSubmit={(input) => void run(form.company ? { action: 'update-company', id: form.company.id, ...input } : { action: 'create-company', ...input })}
            />
          )}
          {form.type === 'contact' && (
            <ContactForm
              contact={form.contact}
              companyId={form.companyId}
              t={t}
              busy={busy}
              error={formError}
              onCancel={() => setForm(null)}
              onSubmit={(input) => void run(form.contact ? { action: 'update-contact', id: form.contact.id, ...input } : { action: 'create-contact', ...input })}
            />
          )}
          {form.type === 'lost' && (
            <LostForm
              t={t}
              busy={busy}
              error={formError}
              onCancel={() => setForm(null)}
              onSubmit={(reason) => void run({ action: 'move-deal', id: form.deal.id, from: form.deal.stage, to: 'lost', lostReason: reason })}
            />
          )}
        </Modal>
      )}
    </div>
  )
}

function Panel({ title, action, className = '', children }: { title?: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`crm-panel ${className}`}>
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

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'accent' | 'won' }) {
  return (
    <div className={`crm-kpi${tone ? ` crm-kpi-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <em>{hint}</em>}
    </div>
  )
}

function StageChip({ stage, t, muted }: { stage: Stage; t: T; muted?: boolean }) {
  return <span className={`crm-chip crm-stage-${stage}${muted ? ' is-muted' : ''}`}>{t(stage)}</span>
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="crm-search">
      <Search size={15} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </label>
  )
}

function TaskCheck({ task, writable, busy, t, onToggle }: { task: Activity; writable: boolean; busy: boolean; t: T; onToggle: (done: boolean) => void }) {
  return (
    <button
      className={`crm-check${task.done ? ' is-checked' : ''}`}
      role="checkbox"
      aria-checked={task.done}
      aria-label={t(task.done ? 'markOpen' : 'markDone')}
      disabled={!writable || busy}
      onClick={() => onToggle(!task.done)}
    >
      {task.done && <Check size={12} strokeWidth={3} />}
    </button>
  )
}

/** Horizontal bars per open stage: the full amount, with the weighted share drawn inside it. */
function StageBars({ totals, locale, t }: { totals: ReturnType<typeof pipelineByStage>; locale: Locale; t: T }) {
  const max = Math.max(1, ...totals.map((s) => s.amount))
  return (
    <figure className="crm-chart">
      <ul className="crm-stage-bars">
        {totals.map((s) => (
          <li key={s.stage} className={`crm-stage-${s.stage}`}>
            <span className="crm-bar-label">
              <i className="crm-dot" />
              {t(s.stage)}
              <em>{s.count}</em>
            </span>
            <span className="crm-bar-track" role="img" aria-label={`${t(s.stage)} ${money(s.amount, locale)}, ${t('weighted')} ${money(s.weighted, locale)}`}>
              <i className="crm-bar-full" style={{ width: `${(s.amount / max) * 100}%` }} />
              <i className="crm-bar-weighted" style={{ width: `${(s.weighted / max) * 100}%` }} />
            </span>
            <span className="crm-bar-figures">
              <strong>{money(s.amount, locale, 'compact')}</strong>
              <em>{money(s.weighted, locale, 'compact')}</em>
            </span>
          </li>
        ))}
      </ul>
      <figcaption>
        <span className="crm-key crm-key-full" />
        {t('amount')}
        <span className="crm-key crm-key-weighted" />
        {t('weighted')}
      </figcaption>
    </figure>
  )
}

function WonChart({ rows, locale, t }: { rows: ReturnType<typeof wonByMonth>; locale: Locale; t: T }) {
  // Drawn at the size it is shown, so the axis text stays legible from a phone to a wide screen.
  const frame = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(640)
  useEffect(() => {
    const element = frame.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const height = width < 480 ? 220 : 280
  const pad = { top: 22, right: 8, bottom: 26, left: 52 }
  const max = Math.max(1, ...rows.map((r) => r.amount))
  const step = niceStep(max / 3)
  const top = Math.ceil(max / step) * step
  const y = (v: number) => pad.top + (1 - v / top) * (height - pad.top - pad.bottom)
  const band = (width - pad.left - pad.right) / rows.length
  const bar = Math.min(56, band * 0.5)
  return (
    <figure className="crm-chart" ref={frame}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('wonPerMonth')}>
        {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} className="crm-gridline" />
            <text x={pad.left - 8} y={y(v) + 4} textAnchor="end" className="crm-axis">
              {money(v, locale, 'compact')}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = pad.left + band * i + band / 2
          const last = i === rows.length - 1
          return (
            <g key={r.month}>
              <rect x={x - bar / 2} y={y(r.amount)} width={bar} height={Math.max(0, y(0) - y(r.amount))} rx={4} className={last ? 'crm-col crm-col-current' : 'crm-col'}>
                <title>{`${monthLabel(r.month, locale)} · ${money(r.amount, locale)} · ${r.count}`}</title>
              </rect>
              {r.count > 0 && (
                <text x={x} y={y(r.amount) - 6} textAnchor="middle" className="crm-col-label">
                  {r.count}
                </text>
              )}
              <text x={x} y={height - 6} textAnchor="middle" className="crm-axis">
                {monthLabel(r.month, locale)}
              </text>
            </g>
          )
        })}
      </svg>
    </figure>
  )
}

function niceStep(raw: number) {
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1)))
  return [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? power * 10
}

function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <Select value={value} onValueChange={(next) => next !== null && onChange(next as string)}>
      <SelectTrigger aria-label={label} className="crm-select">
        <SelectValue>{(v) => options.find(([id]) => id === v)?.[1] ?? ''}</SelectValue>
      </SelectTrigger>
      <SelectContent className="crm-select-popup" positionerClassName="crm-select-positioner">
        {options.map(([id, text]) => (
          <SelectItem key={id || 'all'} value={id}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function CompanyDetail({
  company,
  contacts,
  deals,
  stats,
  writable,
  locale,
  t,
  onEdit,
  onAddContact,
  onEditContact,
  onAddDeal,
  onOpenDeal,
}: {
  company: Company
  contacts: Contact[]
  deals: Deal[]
  stats: { open: number; won: number }
  writable: boolean
  locale: Locale
  t: T
  onEdit: () => void
  onAddContact: () => void
  onEditContact: (contact: Contact) => void
  onAddDeal: () => void
  onOpenDeal: (deal: Deal) => void
}) {
  return (
    <Panel className="crm-company-detail">
      <div className="crm-company-head">
        <span className="crm-logo crm-logo-lg">{initials(company.name, 'company')}</span>
        <div>
          <h2>{company.name}</h2>
          <p className="crm-muted">
            {[t(company.industry), company.city].filter(Boolean).join(' · ')}
            {company.website && (
              <>
                {' · '}
                <a href={company.website} target="_blank" rel="noreferrer">
                  <Globe size={12} /> {company.website.replace(/^https?:\/\//, '')}
                </a>
              </>
            )}
          </p>
        </div>
        {writable && (
          <button className="crm-icon" aria-label={t('editCompany')} title={t('editCompany')} onClick={onEdit}>
            <Pencil size={15} />
          </button>
        )}
      </div>
      <div className="crm-company-stats">
        <Kpi label={t('openPipeline')} value={money(stats.open, locale)} />
        <Kpi label={t('wonToDate')} value={money(stats.won, locale)} tone="won" />
        <Kpi label={t('contacts')} value={String(contacts.length)} />
      </div>
      <section className="crm-subsection">
        <header>
          <h3>{t('contacts')}</h3>
          {writable && (
            <button className="crm-link" onClick={onAddContact}>
              <Plus size={13} /> {t('newContact')}
            </button>
          )}
        </header>
        {contacts.length === 0 ? (
          <p className="crm-empty">{t('noContacts')}</p>
        ) : (
          <ul className="crm-people">
            {contacts.map((c) => (
              <li key={c.id}>
                <span className="crm-avatar crm-avatar-lg">{c.name.replace(/^Dr\.\s*/, '').slice(0, 1)}</span>
                <div>
                  <strong>{c.name}</strong>
                  <span>{c.title}</span>
                </div>
                <div className="crm-person-links">
                  {c.email && (
                    <a href={`mailto:${c.email}`}>
                      <Mail size={13} /> {c.email}
                    </a>
                  )}
                  {c.phone && (
                    <span>
                      <Phone size={13} /> {c.phone}
                    </span>
                  )}
                </div>
                {writable && (
                  <button className="crm-icon" aria-label={t('editContact')} onClick={() => onEditContact(c)}>
                    <Pencil size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="crm-subsection">
        <header>
          <h3>{t('deals')}</h3>
          {writable && (
            <button className="crm-link" onClick={onAddDeal}>
              <Plus size={13} /> {t('newDeal')}
            </button>
          )}
        </header>
        <ul className="crm-mini-deals">
          {deals.map((deal) => (
            <li key={deal.id}>
              <button onClick={() => onOpenDeal(deal)}>
                <span className="crm-mini-main">
                  <strong>{deal.title}</strong>
                  <span>{deal.owner}</span>
                </span>
                <span className="crm-mini-figure">
                  <strong>{money(deal.amount_cents, locale)}</strong>
                  <StageChip stage={deal.stage} t={t} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </Panel>
  )
}

function DealDrawer({
  deal,
  data,
  company,
  contact,
  now,
  today,
  writable,
  busy,
  error,
  locale,
  t,
  onClose,
  onMove,
  onEdit,
  onRun,
}: {
  deal: Deal
  data: CrmData
  company?: Company
  contact?: Contact
  now: Date
  today: string
  writable: boolean
  busy: boolean
  error: string
  locale: Locale
  t: T
  onClose: () => void
  onMove: (to: Stage) => void
  onEdit: () => void
  onRun: (action: CrmAction, after?: () => void) => Promise<boolean>
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [kind, setKind] = useState<ActivityKind>('note')
  const [body, setBody] = useState('')
  const [dueOn, setDueOn] = useState(addDays(today, 3))
  const [local, setLocal] = useState('')
  const history = historyOf(deal.id, data.deal_stage_history)
  // One timeline, newest first: what people did and how the deal moved.
  const timeline = [
    ...data.activities.filter((a) => a.deal_id === deal.id).map((a) => ({ at: a.created_at, activity: a, change: null })),
    ...history.map((h) => ({ at: h.changed_at, activity: null, change: h })),
  ].sort((a, b) => b.at.localeCompare(a.at))
  const reached = Math.max(...history.map((h) => openStages.indexOf(h.to_stage)), openStages.indexOf(deal.stage))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!body.trim()) return setLocal('body_required')
    setLocal('')
    void onRun({ action: 'add-activity', dealId: deal.id, kind, body, dueOn: kind === 'task' ? dueOn : null }, () => setBody(''))
  }
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="crm-backdrop" />
        {/* Focus lands on the panel itself, not on its first button, so nothing looks pressed on open. */}
        <Dialog.Popup ref={panel} initialFocus={panel} className="crm-app crm-drawer">
          <header className="crm-drawer-head">
            <p className="crm-eyebrow">{company?.name}</p>
            <Dialog.Title>{deal.title}</Dialog.Title>
            <div className="crm-drawer-figure">
              <strong>{money(deal.amount_cents, locale)}</strong>
              <StageChip stage={deal.stage} t={t} />
            </div>
            <div className="crm-drawer-actions">
              {writable && (
                <button className="crm-icon" aria-label={t('editDeal')} title={t('editDeal')} onClick={onEdit}>
                  <Pencil size={16} />
                </button>
              )}
              <Dialog.Close className="crm-icon" aria-label={t('close')}>
                <X size={18} />
              </Dialog.Close>
            </div>
          </header>
          <div className="crm-stepper" role="group" aria-label={t('stage')}>
            {stages.map((stage, i) => {
              const state =
                stage === deal.stage ? 'current' : i <= reached && !isClosed(stage) ? 'passed' : isClosed(stage) ? 'closed' : 'ahead'
              return (
                <button
                  key={stage}
                  className={`crm-step crm-step-${state} crm-stage-${stage}`}
                  aria-pressed={stage === deal.stage}
                  disabled={!writable || busy}
                  title={writable && stage !== deal.stage ? `${t('moveTo')} ${t(stage)}` : t(stage)}
                  onClick={() => onMove(stage)}
                >
                  {t(stage)}
                </button>
              )
            })}
          </div>
          {writable && !isClosed(deal.stage) && <p className="crm-hint">{t('stageHint')}</p>}
          <dl className="crm-facts">
            {fact(t('owner'), deal.owner || '—')}
            {fact(
              t('contact'),
              contact ? (
                <>
                  {contact.name}
                  <span className="crm-muted"> · {contact.title}</span>
                </>
              ) : (
                '—'
              ),
            )}
            {isClosed(deal.stage)
              ? fact(t('closedOn'), deal.closed_on ? dayLabel(deal.closed_on, locale, true) : '—')
              : fact(t('expectedClose'), deal.expected_close ? <span className={deal.expected_close < today ? 'is-late' : ''}>{dayLabel(deal.expected_close, locale, true)}</span> : '—')}
            {fact(t('probability'), `${deal.probability}%`)}
            {fact(t('weighted'), money(weighted(deal), locale))}
            {deal.stage === 'lost'
              ? fact(t('lostReason'), deal.lost_reason ? t(deal.lost_reason) : '—')
              : fact(t('daysInStage'), `${daysInStage(deal, data.deal_stage_history, now)} ${t('days')}`)}
          </dl>
          {writable && (
            <form className="crm-log" onSubmit={submit}>
              <div className="crm-segments" role="tablist" aria-label={t('addActivity')}>
                {activityKinds.map((k) => {
                  const Icon = kindIcon[k]
                  return (
                    <button type="button" role="tab" key={k} aria-selected={kind === k} onClick={() => setKind(k)}>
                      <Icon size={13} />
                      {t(kindLabel(k))}
                    </button>
                  )
                })}
              </div>
              <textarea value={body} maxLength={4000} rows={2} onChange={(e) => setBody(e.target.value)} placeholder={t('activityPlaceholder')} aria-label={t('addActivity')} />
              <div className="crm-log-foot">
                {kind === 'task' && (
                  <label className="crm-inline-field">
                    <span>{t('due')}</span>
                    <input type="date" required value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
                  </label>
                )}
                {(local || error) && <p className="crm-error">{t(local || error)}</p>}
                <button type="submit" className="crm-primary" disabled={busy}>
                  {busy ? t('saving') : t('addActivity')}
                </button>
              </div>
            </form>
          )}
          <section className="crm-timeline">
            <h3>{t('history')}</h3>
            {timeline.length === 0 && <p className="crm-empty">{t('nothingYet')}</p>}
            <ol>
              {timeline.map(({ activity, change }) => {
                if (change)
                  return (
                    <li key={change.id} className="crm-event crm-event-stage">
                      <span className={`crm-event-icon crm-stage-${change.to_stage}`}>
                        <ArrowRight size={13} />
                      </span>
                      <div>
                        <p>
                          {change.from_stage ? (
                            <>
                              {t('movedTo')} <StageChip stage={change.to_stage} t={t} /> <span className="crm-muted">{t('from')} {t(change.from_stage)}</span>
                            </>
                          ) : (
                            <>
                              {t('created')} <StageChip stage={change.to_stage} t={t} />
                            </>
                          )}
                        </p>
                        <time>{momentLabel(change.changed_at, locale)}</time>
                      </div>
                    </li>
                  )
                const a = activity!
                const Icon = kindIcon[a.kind] ?? MessageSquareText
                return (
                  <li key={a.id} className={`crm-event crm-event-${a.kind}${a.done ? ' is-done' : ''}`}>
                    {a.kind === 'task' ? (
                      <TaskCheck task={a} writable={writable} busy={busy} t={t} onToggle={(done) => void onRun({ action: 'set-activity-done', id: a.id, done })} />
                    ) : (
                      <span className="crm-event-icon">
                        <Icon size={13} />
                      </span>
                    )}
                    <div>
                      <p>{a.body}</p>
                      <time>
                        {t(kindLabel(a.kind))} · {momentLabel(a.created_at, locale)}
                        {a.due_on && (
                          <span className={a.due_on < today && !a.done ? 'is-late' : ''}>
                            {' · '}
                            {a.done ? t('done') : `${t('due')} ${dayLabel(a.due_on, locale)}`}
                          </span>
                        )}
                      </time>
                    </div>
                  </li>
                )
              })}
            </ol>
          </section>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function fact(label: string, value: ReactNode) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function Modal({ title, closeLabel, onClose, children }: { title: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="crm-backdrop" />
        <Dialog.Popup className="crm-app crm-modal">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close className="crm-icon crm-modal-close" aria-label={closeLabel}>
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
    <label className="crm-field">
      <span>{label}</span>
      {children}
      {hint && <em>{hint}</em>}
    </label>
  )
}

function Actions({ t, busy, error, onCancel }: { t: T; busy: boolean; error: string; onCancel: () => void }) {
  return (
    <>
      {error && <p className="crm-error">{t(error)}</p>}
      <div className="crm-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </button>
        <button type="submit" className="crm-primary" disabled={busy}>
          {busy ? t('saving') : t('save')}
        </button>
      </div>
    </>
  )
}

function DealForm({
  deal,
  companyId,
  data,
  owners,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  deal?: Deal
  companyId?: string
  data: CrmData
  owners: string[]
  t: T
  busy: boolean
  error: string
  onSubmit: (input: DealInput) => void
  onCancel: () => void
}) {
  const sorted = [...data.companies].sort((a, b) => a.name.localeCompare(b.name))
  const [title, setTitle] = useState(deal?.title ?? '')
  const [company, setCompany] = useState(deal?.company_id ?? companyId ?? sorted[0]?.id ?? '')
  const [contact, setContact] = useState(deal?.contact_id ?? '')
  const [amount, setAmount] = useState(deal ? String(deal.amount_cents / 100) : '')
  const [probability, setProbability] = useState(String(deal?.probability ?? stageProbability.lead))
  const [expected, setExpected] = useState(deal?.expected_close ?? '')
  const [owner, setOwner] = useState(deal?.owner ?? owners[0] ?? '')
  const [local, setLocal] = useState('')
  const people = data.contacts.filter((c) => c.company_id === company)
  const closed = !!deal && isClosed(deal.stage)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const cents = parseAmount(amount || '0')
    if (cents === null) return setLocal('invalid_amount')
    const input: DealInput = {
      companyId: company,
      contactId: people.some((p) => p.id === contact) ? contact : null,
      title: title.trim(),
      amountCents: cents,
      probability: closed ? deal!.probability : Number(probability),
      expectedClose: expected || null,
      owner: owner.trim(),
    }
    const problem = validateDeal(input)
    if (problem) return setLocal(problem)
    setLocal('')
    onSubmit(input)
  }
  return (
    <form className="crm-form" onSubmit={submit}>
      <Field label={t('title')}>
        <input required autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div className="crm-form-row">
        <Field label={t('company')}>
          <Choice
            label={t('company')}
            value={company}
            onChange={(next) => {
              setCompany(next)
              setContact('')
            }}
            options={sorted.map((c): [string, string] => [c.id, c.name])}
          />
        </Field>
        <Field label={t('contact')}>
          <Choice label={t('contact')} value={contact} onChange={setContact} options={[['', t('noContact')], ...people.map((p): [string, string] => [p.id, p.name])]} />
        </Field>
      </div>
      <div className="crm-form-row">
        <Field label={`${t('amount')} · $`}>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
        </Field>
        <Field label={`${t('probability')} · %`} hint={closed ? t('probabilityHint') : undefined}>
          <input inputMode="numeric" disabled={closed} value={closed ? String(deal!.probability) : probability} onChange={(e) => setProbability(e.target.value)} />
        </Field>
      </div>
      <div className="crm-form-row">
        <Field label={t('expectedClose')}>
          <input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </Field>
        <Field label={t('owner')}>
          <input list="crm-owners" maxLength={80} value={owner} onChange={(e) => setOwner(e.target.value)} />
          <datalist id="crm-owners">
            {owners.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </Field>
      </div>
      <Actions t={t} busy={busy} error={local || error} onCancel={onCancel} />
    </form>
  )
}

function CompanyForm({
  company,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  company?: Company
  t: T
  busy: boolean
  error: string
  onSubmit: (input: CompanyInput) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(company?.name ?? '')
  const [industry, setIndustry] = useState(company?.industry ?? 'software')
  const [website, setWebsite] = useState(company?.website ?? '')
  const [city, setCity] = useState(company?.city ?? '')
  const [local, setLocal] = useState('')
  const known: string[] = [...industries]
  return (
    <form
      className="crm-form"
      onSubmit={(e) => {
        e.preventDefault()
        const input = { name: name.trim(), industry, website: website.trim(), city: city.trim() }
        const problem = validateCompany(input)
        if (problem) return setLocal(problem)
        setLocal('')
        onSubmit(input)
      }}
    >
      <Field label={t('name')}>
        <input required autoFocus maxLength={160} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="crm-form-row">
        <Field label={t('industry')}>
          <Choice
            label={t('industry')}
            value={industry}
            onChange={setIndustry}
            options={[...(known.includes(industry) ? [] : [[industry, industry] as [string, string]]), ...known.map((i): [string, string] => [i, t(i)])]}
          />
        </Field>
        <Field label={t('city')}>
          <input maxLength={80} value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
      </div>
      <Field label={t('website')}>
        <input type="url" maxLength={300} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" />
      </Field>
      <Actions t={t} busy={busy} error={local || error} onCancel={onCancel} />
    </form>
  )
}

function ContactForm({
  contact,
  companyId,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  contact?: Contact
  companyId: string
  t: T
  busy: boolean
  error: string
  onSubmit: (input: ContactInput) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(contact?.name ?? '')
  const [title, setTitle] = useState(contact?.title ?? '')
  const [email, setEmail] = useState(contact?.email ?? '')
  const [phone, setPhone] = useState(contact?.phone ?? '')
  const [local, setLocal] = useState('')
  return (
    <form
      className="crm-form"
      onSubmit={(e) => {
        e.preventDefault()
        const input = { companyId, name: name.trim(), title: title.trim(), email: email.trim(), phone: phone.trim() }
        const problem = validateContact(input)
        if (problem) return setLocal(problem)
        setLocal('')
        onSubmit(input)
      }}
    >
      <div className="crm-form-row">
        <Field label={t('personName')}>
          <input required autoFocus maxLength={160} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('jobTitle')}>
          <input maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
      </div>
      <div className="crm-form-row">
        <Field label={t('email')}>
          <input type="email" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('phone')}>
          <input type="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
      <Actions t={t} busy={busy} error={local || error} onCancel={onCancel} />
    </form>
  )
}

function LostForm({ t, busy, error, onSubmit, onCancel }: { t: T; busy: boolean; error: string; onSubmit: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState<string>(lostReasons[0])
  return (
    <form
      className="crm-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(reason)
      }}
    >
      <p className="crm-muted">{t('lostHint')}</p>
      <div className="crm-reasons" role="radiogroup" aria-label={t('lostReason')}>
        {lostReasons.map((r) => (
          <button type="button" key={r} role="radio" aria-checked={reason === r} onClick={() => setReason(r)}>
            {t(r)}
          </button>
        ))}
      </div>
      <Actions t={t} busy={busy} error={error} onCancel={onCancel} />
    </form>
  )
}
