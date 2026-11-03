import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import {
  ArrowLeft,
  Ban,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  LayoutDashboard,
  ListChecks,
  Mail,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  UserX,
  Users,
  X,
} from 'lucide-react'
import {
  SLOT_MINUTES,
  addDays,
  anchorDay,
  atLocal,
  awaitingCheckout,
  busyHours,
  clock,
  customerSummary,
  dayKey,
  dayOf,
  dayRange,
  endFor,
  errorKey,
  findConflict,
  freeStarts,
  holdsSlot,
  hoursOn,
  localized,
  minutesBetween,
  minutesOf,
  money,
  noShowRate,
  parseClock,
  parsePrice,
  problemWith,
  resourceColors,
  revenue,
  statuses,
  utilization,
  weekDays,
  weekStart,
  type Booking,
  type BookingAction,
  type BookingData,
  type BookingProps,
  type BookingStatus,
  type Customer,
  type Locale,
  type Resource,
  type ResourceKind,
  type Service,
} from '@lovbase/core/booking'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { translate } from './labels'
import './booking.css'

type Page = 'schedule' | 'week' | 'bookings' | 'customers' | 'catalog' | 'dashboard'
type Form =
  | { type: 'book'; id: string; customerId: string; booking?: Booking; resourceId?: string; day: string; start?: number; forCustomer?: string }
  | { type: 'detail'; bookingId: string }
  | { type: 'customer'; id: string; customer?: Customer }
  | { type: 'service'; id: string; service?: Service }
  | { type: 'resource'; id: string; resource?: Resource }
  | { type: 'hours'; weekday: number }
type T = (key: string) => string
type Lookup = {
  resources: Map<string, Resource>
  services: Map<string, Service>
  customers: Map<string, Customer>
}

const navigation: [Page, typeof CalendarDays][] = [
  ['schedule', CalendarDays],
  ['week', CalendarRange],
  ['bookings', ListChecks],
  ['customers', Users],
  ['catalog', Sparkles],
  ['dashboard', LayoutDashboard],
]
/** Pixels per hour in the day schedule and the week view. */
const DAY_HOUR = 72
const WEEK_HOUR = 46
const weekdayOrder = [1, 2, 3, 4, 5, 6, 0]
const tag = (locale: Locale) => (locale === 'zh' ? 'zh-CN' : 'en-GB')
function dayLabel(day: string, locale: Locale, options: Intl.DateTimeFormatOptions) {
  const [y, m, d] = day.split('-').map(Number)
  return new Intl.DateTimeFormat(tag(locale), { ...options, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
}
const weekdayName = (weekday: number, locale: Locale, style: 'long' | 'short' = 'long') =>
  dayLabel(addDays('2026-11-01', weekday), locale, { weekday: style })
const timeOf = (iso: string) => clock(minutesOf(iso))
const span = (b: Pick<Booking, 'starts_at' | 'ends_at'>) => `${timeOf(b.starts_at)}–${timeOf(b.ends_at)}`
const initials = (name: string) =>
  /^[A-Za-z]/.test(name)
    ? name
        .split(/\s+/)
        .map((part) => part[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : name.slice(-2)
const tint = (color: string) => ({ '--c': color }) as CSSProperties

export function BookingApp({ client, initialLocale = 'en', locale: controlledLocale, onLocaleChange, initialData }: BookingProps) {
  const [localLocale, setLocalLocale] = useState<Locale>(initialLocale)
  const locale = controlledLocale ?? localLocale
  const t: T = (key) => translate(locale, key)
  const [data, setData] = useState<BookingData | null>(initialData ?? null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(!initialData)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [page, setPage] = useState<Page>('schedule')
  const [form, setForm] = useState<Form | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  const read = useCallback(async () => {
    setLoading(true)
    try {
      setData(await client.read())
      setError('')
    } catch (e) {
      setError(errorKey(e instanceof Error ? e.message : ''))
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

  // Several actions run in order (a new customer, then their booking). Each form keeps the ids it
  // was opened with, so trying again after a failure reuses them and cannot create duplicates.
  const run = async (...actions: BookingAction[]) => {
    if (busy || data?.readOnly) return
    setBusy(true)
    setFormError('')
    setNotice('')
    try {
      for (const action of actions) await client.run(action)
      setData(await client.read())
      setForm(null)
    } catch (e) {
      const key = errorKey(e instanceof Error ? e.message : '')
      if (form && form.type !== 'detail') setFormError(key)
      else setNotice(key)
      // Someone else took the slot: show it, so the free times in the form are right again.
      if (key === 'booking_overlap') await client.read().then(setData, () => {})
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
    const lookup: Lookup = {
      resources: new Map(data.resources.map((r) => [r.id, r])),
      services: new Map(data.services.map((s) => [s.id, s])),
      customers: new Map(data.customers.map((c) => [c.id, c])),
    }
    const today = dayKey(new Date())
    // A copy lives on today. The demo lives on the day it was seeded, at the current time of day,
    // so "now", "this week" and "awaiting checkout" read the same however old the demo is.
    const anchor = anchorDay(data, today)
    const nowDate = new Date()
    const now = anchor === today ? nowDate.toISOString() : atLocal(anchor, nowDate.getHours() * 60 + nowDate.getMinutes())
    const ordered = <R extends { created_at: string; id: string }>(rows: R[]) =>
      [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    const sorted = [...data.bookings].sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    return { lookup, anchor, now, resources: ordered(data.resources), services: ordered(data.services), sorted }
  }, [data])

  if (!data || !view)
    return (
      <div className="booking-app bk-center">
        {error ? (
          <div>
            <p>{t(error)}</p>
            <button onClick={() => void read()}>{t('retry')}</button>
          </div>
        ) : (
          <p className="bk-muted">{loading ? t('loading') : ''}</p>
        )}
      </div>
    )

  const day = selectedDay ?? view.anchor
  const name = (value: { name: string; name_en: string } | undefined) => (value ? localized(value, locale) : '—')
  const describe = (b: Booking) => ({
    resource: view.lookup.resources.get(b.resource_id),
    service: view.lookup.services.get(b.service_id),
    customer: view.lookup.customers.get(b.customer_id),
  })
  const newBooking = (extra: Partial<Extract<Form, { type: 'book' }>> = {}) =>
    open({ type: 'book', id: crypto.randomUUID(), customerId: crypto.randomUUID(), day, ...extra })
  const shared = { data, view, locale, t, name, describe }
  const go = (next: Page) => {
    setPage(next)
    setNotice('')
  }

  let content: ReactNode
  if (page === 'schedule')
    content = (
      <DaySchedule
        {...shared}
        day={day}
        onDay={setSelectedDay}
        onSlot={(resourceId, start) => newBooking({ resourceId, start })}
        onOpen={(b) => open({ type: 'detail', bookingId: b.id })}
      />
    )
  else if (page === 'week')
    content = (
      <WeekView
        {...shared}
        day={day}
        onDay={setSelectedDay}
        onPickDay={(d) => {
          setSelectedDay(d)
          go('schedule')
        }}
        onOpen={(b) => open({ type: 'detail', bookingId: b.id })}
      />
    )
  else if (page === 'bookings')
    content = <BookingList {...shared} busy={busy} onOpen={(b) => open({ type: 'detail', bookingId: b.id })} onStatus={(id, status) => void run({ type: 'set-status', id, status })} />
  else if (page === 'customers')
    content = (
      <CustomerBook
        {...shared}
        onOpen={(b) => open({ type: 'detail', bookingId: b.id })}
        onEdit={(customer) => open({ type: 'customer', id: customer.id, customer })}
        onBook={(customer) => newBooking({ forCustomer: customer.id, day: view.anchor })}
      />
    )
  else if (page === 'catalog')
    content = (
      <Catalog
        {...shared}
        onService={(service) => open({ type: 'service', id: service?.id ?? crypto.randomUUID(), service })}
        onResource={(resource) => open({ type: 'resource', id: resource?.id ?? crypto.randomUUID(), resource })}
        onHours={(weekday) => open({ type: 'hours', weekday })}
      />
    )
  else content = <Dashboard {...shared} onOpen={(b) => open({ type: 'detail', bookingId: b.id })} onSeeSchedule={() => {
    setSelectedDay(null)
    go('schedule')
  }} />

  const intro = data.readOnly && page === 'schedule' ? 'scheduleIntroReadonly' : `${page}Intro`
  const detail = form?.type === 'detail' ? data.bookings.find((b) => b.id === form.bookingId) : undefined
  const modalTitle = !form
    ? ''
    : form.type === 'book'
      ? t(form.booking ? 'editBooking' : 'newBooking')
      : form.type === 'detail'
        ? t('booking')
        : form.type === 'customer'
          ? t(form.customer ? 'editCustomer' : 'addCustomer')
          : form.type === 'service'
            ? t(form.service ? 'editService' : 'addService')
            : form.type === 'resource'
              ? t(form.resource ? 'editResource' : 'addResource')
              : `${t('editHours')} · ${weekdayName(form.weekday, locale)}`

  return (
    <div className="booking-app">
      <aside className="bk-sidebar">
        <div className="bk-brand">
          <span className="bk-mark" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <div>
            <strong>{t('brand')}</strong>
            <span>{t('studio')}</span>
          </div>
        </div>
        <nav>
          {navigation.map(([id, Icon]) => (
            <button key={id} data-page={id} title={t(id)} aria-current={page === id ? 'page' : undefined} onClick={() => go(id)}>
              <Icon size={17} />
              <span>{t(id)}</span>
            </button>
          ))}
        </nav>
        <div className="bk-sidebar-foot">
          <div className="bk-language" aria-label={t('language')}>
            {(['zh', 'en'] as const).map((l) => (
              <button key={l} aria-pressed={locale === l} onClick={() => switchLocale(l)}>
                {l === 'zh' ? '中文' : 'EN'}
              </button>
            ))}
          </div>
          <button className="bk-icon" aria-label={t('refresh')} title={t('refresh')} disabled={loading} onClick={() => void read()}>
            <RefreshCw size={16} />
          </button>
        </div>
      </aside>
      <div className="bk-body">
        {data.readOnly && (
          <div className="bk-demo">
            <span className="bk-dot" />
            {t('readonly')}
          </div>
        )}
        <main className="bk-main">
          <div className="bk-title">
            <div>
              <h1>{t(page)}</h1>
              <p>{t(intro)}</p>
            </div>
            <div className="bk-toolbar">
              {page === 'customers' && !data.readOnly && (
                <button onClick={() => open({ type: 'customer', id: crypto.randomUUID() })}>
                  <Plus size={16} />
                  {t('addCustomer')}
                </button>
              )}
              {!data.readOnly && (
                <button className="bk-primary" onClick={() => newBooking()}>
                  <Plus size={16} />
                  {t('newBooking')}
                </button>
              )}
            </div>
          </div>
          {notice && (
            <p className="bk-error bk-notice" role="alert">
              {t(notice)}
              <button className="bk-icon" aria-label={t('close')} onClick={() => setNotice('')}>
                <X size={14} />
              </button>
            </p>
          )}
          {content}
        </main>
      </div>
      {form && (form.type !== 'detail' || detail) && (
        <Modal title={modalTitle} onClose={() => !busy && setForm(null)} t={t} wide={form.type === 'book'}>
          {form.type === 'book' && (
            <BookingForm
              {...shared}
              form={form}
              busy={busy}
              error={formError}
              onCancel={() => setForm(null)}
              onSubmit={(actions) => void run(...actions)}
            />
          )}
          {form.type === 'detail' && detail && (
            <BookingDetail
              {...shared}
              booking={detail}
              busy={busy}
              onStatus={(status) => void run({ type: 'set-status', id: detail.id, status })}
              onEdit={() => open({ type: 'book', id: detail.id, customerId: detail.customer_id, booking: detail, day: dayOf(detail.starts_at) })}
            />
          )}
          {form.type === 'customer' && (
            <CustomerForm id={form.id} customer={form.customer} t={t} busy={busy} error={formError} onCancel={() => setForm(null)} onSubmit={(a) => void run(a)} />
          )}
          {form.type === 'service' && (
            <ServiceForm id={form.id} service={form.service} t={t} busy={busy} error={formError} onCancel={() => setForm(null)} onSubmit={(a) => void run(a)} />
          )}
          {form.type === 'resource' && (
            <ResourceForm
              id={form.id}
              resource={form.resource}
              used={data.resources.map((r) => r.color)}
              t={t}
              busy={busy}
              error={formError}
              onCancel={() => setForm(null)}
              onSubmit={(a) => void run(a)}
            />
          )}
          {form.type === 'hours' && (
            <HoursForm
              weekday={form.weekday}
              current={data.opening_hours.find((h) => h.weekday === form.weekday)}
              t={t}
              busy={busy}
              error={formError}
              onCancel={() => setForm(null)}
              onSubmit={(a) => void run(a)}
            />
          )}
        </Modal>
      )}
    </div>
  )
}

type Shared = {
  data: BookingData
  view: { lookup: Lookup; anchor: string; now: string; resources: Resource[]; services: Service[]; sorted: Booking[] }
  locale: Locale
  t: T
  name: (value: { name: string; name_en: string } | undefined) => string
  describe: (b: Booking) => { resource?: Resource; service?: Service; customer?: Customer }
}

/** Active resources, plus a paused one on days it still has bookings. */
function columnsFor(view: Shared['view'], bookings: Booking[]) {
  const busy = new Set(bookings.map((b) => b.resource_id))
  return view.resources.filter((r) => r.active || busy.has(r.id))
}

function DayNavigator({ day, step, onDay, label, anchor, t }: { day: string; step: number; onDay: (d: string | null) => void; label: string; anchor: string; t: T }) {
  return (
    <div className="bk-daynav">
      <button className="bk-icon" aria-label={t('previous')} onClick={() => onDay(addDays(day, -step))}>
        <ChevronLeft size={18} />
      </button>
      <button className="bk-today" disabled={day === anchor} onClick={() => onDay(null)}>
        {t('today')}
      </button>
      <button className="bk-icon" aria-label={t('next')} onClick={() => onDay(addDays(day, step))}>
        <ChevronRight size={18} />
      </button>
      <h2>{label}</h2>
    </div>
  )
}

function DaySchedule({
  data,
  view,
  locale,
  t,
  name,
  describe,
  day,
  onDay,
  onSlot,
  onOpen,
}: Shared & { day: string; onDay: (d: string | null) => void; onSlot: (resourceId: string, start: number) => void; onOpen: (b: Booking) => void }) {
  const open = hoursOn(data.opening_hours, day)
  const bookings = view.sorted.filter((b) => holdsSlot(b) && dayOf(b.starts_at) === day)
  const columns = columnsFor(view, bookings)
  const range = dayRange(open, bookings)
  const px = DAY_HOUR / 60
  const y = (minutes: number) => (minutes - range.opens) * px
  const hours = Array.from({ length: (range.closes - range.opens) / 60 }, (_, i) => range.opens + i * 60)
  const isToday = dayOf(view.now) === day
  const nowMinutes = minutesOf(view.now)
  const openLength = open ? open.closes - open.opens : 0
  return (
    <section className="bk-panel bk-schedule">
      <header className="bk-schedule-head">
        <DayNavigator
          day={day}
          step={1}
          onDay={onDay}
          anchor={view.anchor}
          t={t}
          label={dayLabel(day, locale, { weekday: 'long', month: 'long', day: 'numeric' })}
        />
        <div className="bk-chips">
          <span className="bk-chip">
            <Clock3 size={13} />
            {open ? `${t('openFrom')} ${clock(open.opens)}–${clock(open.closes)}` : t('closed')}
          </span>
          <span className="bk-chip">
            {bookings.length} {t('countBookings')}
          </span>
        </div>
      </header>
      {columns.length === 0 ? (
        <p className="bk-empty">{t('noResources')}</p>
      ) : (
        <div className="bk-grid-scroll">
          <div className="bk-day-grid" style={{ '--columns': columns.length } as CSSProperties}>
            <div className="bk-corner" />
            {columns.map((r) => {
              const mine = bookings.filter((b) => b.resource_id === r.id)
              const booked = mine.reduce((sum, b) => sum + minutesBetween(b.starts_at, b.ends_at), 0)
              return (
                <div key={r.id} className="bk-col-head" style={tint(r.color)}>
                  <span className="bk-swatch" />
                  <div>
                    <strong>{name(r)}</strong>
                    <span>
                      {t(r.kind)} · {mine.length} {t('countBookings')}
                      {openLength ? ` · ${Math.round((Math.min(booked, openLength) / openLength) * 100)}%` : ''}
                    </span>
                  </div>
                </div>
              )
            })}
            <div className="bk-gutter" style={{ height: hours.length * DAY_HOUR }}>
              {hours.map((h) => (
                <span key={h} style={{ top: y(h) }}>
                  {clock(h)}
                </span>
              ))}
            </div>
            {columns.map((r) => {
              const mine = bookings.filter((b) => b.resource_id === r.id)
              const slots: number[] = []
              if (open && !data.readOnly && r.active)
                for (let m = open.opens; m < open.closes; m += SLOT_MINUTES) {
                  const from = atLocal(day, m)
                  if (!findConflict(mine, { resource_id: r.id, starts_at: from, ends_at: endFor(from, SLOT_MINUTES) })) slots.push(m)
                }
              return (
                <div key={r.id} className="bk-col" style={{ ...tint(r.color), height: hours.length * DAY_HOUR, backgroundSize: `100% ${DAY_HOUR}px` }}>
                  {open ? (
                    <>
                      {open.opens > range.opens && <div className="bk-off" style={{ top: 0, height: y(open.opens) }} />}
                      {open.closes < range.closes && <div className="bk-off" style={{ top: y(open.closes), bottom: 0 }} />}
                    </>
                  ) : (
                    <div className="bk-off bk-off-day" style={{ top: 0, bottom: 0 }}>
                      <span>{t('closed')}</span>
                    </div>
                  )}
                  {slots.map((m) => (
                    <button
                      key={m}
                      className="bk-slot"
                      style={{ top: y(m), height: SLOT_MINUTES * px }}
                      aria-label={`${t('bookSlot')} ${name(r)} ${clock(m)}`}
                      onClick={() => onSlot(r.id, m)}
                    >
                      <Plus size={12} />
                      {clock(m)}
                    </button>
                  ))}
                  {mine.map((b) => {
                    const { service, customer } = describe(b)
                    const length = minutesBetween(b.starts_at, b.ends_at)
                    const top = y(minutesOf(b.starts_at))
                    return (
                      <button
                        key={b.id}
                        className={`bk-block is-${b.status}${awaitingCheckout(b, view.now) ? ' is-awaiting' : ''}${length <= 30 ? ' is-short' : length < 60 ? ' is-compact' : ''}`}
                        style={{ top: top + 1, height: Math.max(length * px - 3, 20) }}
                        onClick={() => onOpen(b)}
                      >
                        <span className="bk-block-line">
                          <span className="bk-block-time">
                            {span(b)}
                            {b.status === 'completed' && <Check size={12} />}
                            {b.status === 'no_show' && <UserX size={12} />}
                          </span>
                          <strong>{customer?.name ?? '—'}</strong>
                        </span>
                        <span className="bk-block-service">{name(service)}</span>
                      </button>
                    )
                  })}
                  {isToday && nowMinutes >= range.opens && nowMinutes <= range.closes && (
                    <div className="bk-now" style={{ top: y(nowMinutes) }} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

function WeekView({
  data,
  view,
  locale,
  t,
  name,
  describe,
  day,
  onDay,
  onPickDay,
  onOpen,
}: Shared & { day: string; onDay: (d: string | null) => void; onPickDay: (d: string) => void; onOpen: (b: Booking) => void }) {
  const days = weekDays(day)
  const inWeek = view.sorted.filter((b) => holdsSlot(b) && days.includes(dayOf(b.starts_at)))
  const lanes = columnsFor(view, inWeek)
  const range = days.reduce(
    (acc, d) => {
      const r = dayRange(hoursOn(data.opening_hours, d), inWeek.filter((b) => dayOf(b.starts_at) === d))
      return { opens: Math.min(acc.opens, r.opens), closes: Math.max(acc.closes, r.closes) }
    },
    { opens: 24 * 60, closes: 0 },
  )
  const px = WEEK_HOUR / 60
  const hours = Array.from({ length: (range.closes - range.opens) / 60 }, (_, i) => range.opens + i * 60)
  const height = hours.length * WEEK_HOUR
  const utc = (d: string) => new Date(d + 'T00:00:00Z')
  const label = new Intl.DateTimeFormat(tag(locale), { month: 'long', day: 'numeric', timeZone: 'UTC' }).formatRange(utc(days[0]), utc(days[6]))
  return (
    <section className="bk-panel bk-schedule">
      <header className="bk-schedule-head">
        <DayNavigator day={day} step={7} onDay={onDay} anchor={weekStart(view.anchor) === weekStart(day) ? day : view.anchor} t={t} label={label} />
        <div className="bk-legend">
          {lanes.map((r) => (
            <span key={r.id} style={tint(r.color)}>
              <i />
              {name(r)}
            </span>
          ))}
        </div>
      </header>
      <div className="bk-grid-scroll">
        <div className="bk-week-grid">
          <div className="bk-corner" />
          {days.map((d) => {
            const count = inWeek.filter((b) => dayOf(b.starts_at) === d).length
            const closed = !hoursOn(data.opening_hours, d)
            return (
              <button key={d} className={`bk-week-head${d === view.anchor ? ' is-today' : ''}`} onClick={() => onPickDay(d)}>
                <span>{dayLabel(d, locale, { weekday: 'short' })}</span>
                <strong>{dayLabel(d, locale, { day: 'numeric' })}</strong>
                <em>
                  {closed && !count ? (
                    t('closed')
                  ) : (
                    <>
                      {count}
                      <span> {t('countBookings')}</span>
                    </>
                  )}
                </em>
              </button>
            )
          })}
          <div className="bk-gutter" style={{ height }}>
            {hours.map((h) => (
              <span key={h} style={{ top: (h - range.opens) * px }}>
                {clock(h)}
              </span>
            ))}
          </div>
          {days.map((d) => {
            const open = hoursOn(data.opening_hours, d)
            return (
              <div key={d} className={`bk-week-col${d === view.anchor ? ' is-today' : ''}`} style={{ height, backgroundSize: `100% ${WEEK_HOUR}px` }}>
                {!open && <div className="bk-off bk-off-day" style={{ top: 0, bottom: 0 }} />}
                {open && open.opens > range.opens && <div className="bk-off" style={{ top: 0, height: (open.opens - range.opens) * px }} />}
                {open && open.closes < range.closes && <div className="bk-off" style={{ top: (open.closes - range.opens) * px, bottom: 0 }} />}
                {inWeek
                  .filter((b) => dayOf(b.starts_at) === d)
                  .map((b) => {
                    const lane = Math.max(0, lanes.findIndex((r) => r.id === b.resource_id))
                    const { resource, service, customer } = describe(b)
                    const length = minutesBetween(b.starts_at, b.ends_at)
                    return (
                      <button
                        key={b.id}
                        className={`bk-week-block is-${b.status}`}
                        style={{
                          ...tint(resource?.color ?? resourceColors[0]),
                          top: (minutesOf(b.starts_at) - range.opens) * px + 1,
                          height: Math.max(length * px - 2, 8),
                          left: `calc(${(lane / lanes.length) * 100}% + 2px)`,
                          width: `calc(${100 / lanes.length}% - 4px)`,
                        }}
                        title={`${span(b)} · ${customer?.name ?? ''} · ${name(service)} · ${name(resource)}`}
                        aria-label={`${span(b)} ${customer?.name ?? ''} ${name(service)}`}
                        onClick={() => onOpen(b)}
                      >
                        {length >= 45 && <span>{timeOf(b.starts_at)}</span>}
                      </button>
                    )
                  })}
                {dayOf(view.now) === d && minutesOf(view.now) >= range.opens && minutesOf(view.now) <= range.closes && (
                  <div className="bk-now" style={{ top: (minutesOf(view.now) - range.opens) * px }} />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function StatusPill({ booking, now, t }: { booking: Booking; now: string; t: T }) {
  const awaiting = awaitingCheckout(booking, now)
  return <span className={`bk-status is-${awaiting ? 'awaiting' : booking.status}`}>{t(awaiting ? 'awaiting' : booking.status)}</span>
}

function StatusActions({ booking, busy, onStatus, t, labels = false }: { booking: Booking; busy: boolean; onStatus: (s: BookingStatus) => void; t: T; labels?: boolean }) {
  if (booking.status !== 'confirmed')
    return labels ? (
      <button disabled={busy} onClick={() => onStatus('confirmed')}>
        <RotateCcw size={15} />
        {t('reopen')}
      </button>
    ) : null
  const actions: [BookingStatus, typeof Check, string][] = [
    ['completed', Check, 'complete'],
    ['no_show', UserX, 'markNoShow'],
    ['cancelled', Ban, 'cancelBooking'],
  ]
  return (
    <>
      {actions.map(([status, Icon, label]) => (
        <button
          key={status}
          className={labels ? (status === 'completed' ? 'bk-primary' : '') : 'bk-icon'}
          disabled={busy}
          title={t(label)}
          aria-label={t(label)}
          onClick={(e) => {
            e.stopPropagation()
            onStatus(status)
          }}
        >
          <Icon size={15} />
          {labels && t(label)}
        </button>
      ))}
    </>
  )
}

function BookingList({ data, view, locale, t, name, describe, busy, onOpen, onStatus }: Shared & { busy: boolean; onOpen: (b: Booking) => void; onStatus: (id: string, status: BookingStatus) => void }) {
  const anchor = view.anchor
  const [from, setFrom] = useState(anchor)
  const [to, setTo] = useState(addDays(anchor, 13))
  const [resource, setResource] = useState('')
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState('')
  const presets: [string, string, string][] = [
    ['presetToday', anchor, anchor],
    ['presetWeek', weekStart(anchor), addDays(weekStart(anchor), 6)],
    ['presetNext', anchor, addDays(anchor, 13)],
    ['presetPast', addDays(anchor, -30), addDays(anchor, -1)],
  ]
  const needle = query.trim().toLowerCase()
  const rows = view.sorted.filter((b) => {
    const d = dayOf(b.starts_at)
    if (d < from || d > to || (resource && b.resource_id !== resource)) return false
    if (status && (status === 'awaiting' ? !awaitingCheckout(b, view.now) : b.status !== status)) return false
    if (!needle) return true
    const customer = view.lookup.customers.get(b.customer_id)
    return `${customer?.name} ${customer?.phone} ${b.notes}`.toLowerCase().includes(needle)
  })
  const value = rows.filter((b) => b.status === 'completed' || b.status === 'confirmed').reduce((sum, b) => sum + b.price_cents, 0)
  const shown = rows.slice(0, 300)
  return (
    <section className="bk-panel">
      <div className="bk-filters">
        <div className="bk-presets">
          {presets.map(([key, a, b]) => (
            <button
              key={key}
              aria-pressed={from === a && to === b}
              onClick={() => {
                setFrom(a)
                setTo(b)
              }}
            >
              {t(key)}
            </button>
          ))}
        </div>
        <div className="bk-filter-row">
          <label className="bk-date">
            <span>{t('from')}</span>
            <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          </label>
          <label className="bk-date">
            <span>{t('to')}</span>
            <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
          </label>
          <Choice label={t('with')} value={resource} onChange={setResource} options={[['', t('allResources')], ...view.resources.map((r): [string, string] => [r.id, name(r)])]} />
          <Choice
            label={t('status')}
            value={status}
            onChange={setStatus}
            options={[['', t('allStatuses')], ['awaiting', t('awaiting')], ...statuses.map((s): [string, string] => [s, t(s)])]}
          />
          <label className="bk-search">
            <Search size={15} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search')} />
          </label>
        </div>
      </div>
      <p className="bk-summary">
        <strong>{rows.length}</strong> {t('countBookings')} · {money(value, locale, true)} {t('expected')}
        {rows.length > 300 && <em> · {t('shownFirst')}</em>}
      </p>
      {rows.length === 0 ? (
        <p className="bk-empty">{t('noBookings')}</p>
      ) : (
        <div className="bk-table" role="table">
          <div className="bk-row bk-row-head" role="row">
            <span role="columnheader">{t('when')}</span>
            <span role="columnheader">{t('customer')}</span>
            <span role="columnheader">{t('service')}</span>
            <span role="columnheader">{t('with')}</span>
            <span role="columnheader" className="bk-num">
              {t('price')}
            </span>
            <span role="columnheader">{t('status')}</span>
            <span role="columnheader" />
          </div>
          {shown.map((b, i) => {
            const { resource: r, service, customer } = describe(b)
            const d = dayOf(b.starts_at)
            const newDay = i === 0 || d !== dayOf(shown[i - 1].starts_at)
            return (
              <div key={b.id} className={`bk-row${newDay ? ' is-first' : ''}${b.status === 'cancelled' ? ' is-cancelled' : ''}`} role="row" onClick={() => onOpen(b)}>
                <span className="bk-when" role="cell">
                  <em>{newDay ? dayLabel(d, locale, { weekday: 'short', month: 'short', day: 'numeric' }) : ''}</em>
                  {span(b)}
                </span>
                <strong role="cell">{customer?.name ?? '—'}</strong>
                <span role="cell">{name(service)}</span>
                <span role="cell" className="bk-with" style={tint(r?.color ?? resourceColors[0])}>
                  <i />
                  {name(r)}
                </span>
                <span role="cell" className="bk-num">
                  {money(b.price_cents, locale, true)}
                </span>
                <span role="cell">
                  <StatusPill booking={b} now={view.now} t={t} />
                </span>
                <span role="cell" className="bk-row-actions">
                  {!data.readOnly && <StatusActions booking={b} busy={busy} onStatus={(s) => onStatus(b.id, s)} t={t} />}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function CustomerBook({
  data,
  view,
  locale,
  t,
  name,
  describe,
  onOpen,
  onEdit,
  onBook,
}: Shared & { onOpen: (b: Booking) => void; onEdit: (c: Customer) => void; onBook: (c: Customer) => void }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const latest = useMemo(() => {
    const seen = new Map<string, string>()
    for (const b of view.sorted) if (b.status === 'completed') seen.set(b.customer_id, b.starts_at)
    return seen
  }, [view.sorted])
  const needle = query.trim().toLowerCase()
  const list = [...data.customers]
    .filter((c) => `${c.name} ${c.phone} ${c.email}`.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name, tag(locale)))
  const current = data.customers.find((c) => c.id === selected) ?? (selected === null ? list[0] : undefined)
  const summary = current ? customerSummary(data.bookings, current.id, view.now) : null
  const short = (iso: string) => dayLabel(dayOf(iso), locale, { month: 'short', day: 'numeric' })
  return (
    <div className={`bk-customers${selected ? ' has-selection' : ''}`}>
      <section className="bk-panel bk-customer-list">
        <label className="bk-search">
          <Search size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchCustomers')} />
        </label>
        {list.length === 0 && <p className="bk-empty">{t('noCustomers')}</p>}
        <ul>
          {list.map((c) => {
            const last = latest.get(c.id)
            return (
              <li key={c.id}>
                <button aria-current={current?.id === c.id ? 'true' : undefined} onClick={() => setSelected(c.id)}>
                  <span className="bk-avatar">{initials(c.name)}</span>
                  <span>
                    <strong>{c.name}</strong>
                    <em>{c.phone || c.email || '—'}</em>
                  </span>
                  <span className="bk-customer-last">{last ? short(last) : ''}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>
      {current && summary && (
        <section className="bk-panel bk-customer-detail">
          <header className="bk-customer-head">
            <button className="bk-icon bk-back" aria-label={t('back')} onClick={() => setSelected(null)}>
              <ArrowLeft size={18} />
            </button>
            <span className="bk-avatar bk-avatar-lg">{initials(current.name)}</span>
            <div>
              <h2>{current.name}</h2>
              <p>
                {current.phone && (
                  <span>
                    <Phone size={13} />
                    {current.phone}
                  </span>
                )}
                {current.email && (
                  <span>
                    <Mail size={13} />
                    {current.email}
                  </span>
                )}
              </p>
            </div>
            {!data.readOnly && (
              <div className="bk-toolbar">
                <button onClick={() => onEdit(current)}>
                  <Pencil size={15} />
                  {t('edit')}
                </button>
                <button className="bk-primary" onClick={() => onBook(current)}>
                  <Plus size={15} />
                  {t('bookFor')}
                </button>
              </div>
            )}
          </header>
          {current.notes && <p className="bk-note">{current.notes}</p>}
          <div className="bk-stats">
            <Kpi label={t('visits')} value={String(summary.visits)} />
            <Kpi label={t('spent')} value={money(summary.spent, locale, true)} />
            <Kpi label={t('noShows')} value={String(summary.noShows)} tone={summary.noShows ? 'warn' : undefined} />
            <Kpi
              label={t('nextVisit')}
              value={summary.nextVisit ? dayLabel(dayOf(summary.nextVisit.starts_at), locale, { month: 'short', day: 'numeric' }) : '—'}
              hint={summary.nextVisit ? timeOf(summary.nextVisit.starts_at) : summary.lastVisit ? `${t('lastVisit')} ${short(summary.lastVisit.starts_at)}` : undefined}
            />
          </div>
          <h3 className="bk-subhead">{t('history')}</h3>
          {summary.history.length === 0 ? (
            <p className="bk-empty">{t('noHistory')}</p>
          ) : (
            <ul className="bk-history">
              {summary.history.map((b) => {
                const { resource, service } = describe(b)
                return (
                  <li key={b.id}>
                    <button onClick={() => onOpen(b)}>
                      <span className="bk-history-date">
                        <strong>{dayLabel(dayOf(b.starts_at), locale, { month: 'short', day: 'numeric' })}</strong>
                        <em>{timeOf(b.starts_at)}</em>
                      </span>
                      <span className="bk-history-what">
                        <strong>{name(service)}</strong>
                        <span className="bk-with" style={tint(resource?.color ?? resourceColors[0])}>
                          <i />
                          {name(resource)}
                        </span>
                      </span>
                      <span className="bk-num">{money(b.price_cents, locale, true)}</span>
                      <StatusPill booking={b} now={view.now} t={t} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

function Catalog({
  data,
  view,
  locale,
  t,
  name,
  onService,
  onResource,
  onHours,
}: Shared & { onService: (s?: Service) => void; onResource: (r?: Resource) => void; onHours: (weekday: number) => void }) {
  const counts = new Map<string, number>()
  for (const b of data.bookings) if (holdsSlot(b)) counts.set(b.service_id, (counts.get(b.service_id) ?? 0) + 1)
  return (
    <div className="bk-grid">
      <Panel
        title={t('services')}
        className="bk-span-2"
        action={
          !data.readOnly && (
            <button onClick={() => onService()}>
              <Plus size={15} />
              {t('addService')}
            </button>
          )
        }
      >
        <ul className="bk-list">
          {view.services.map((s) => (
            <li key={s.id} className={s.active ? '' : 'is-paused'}>
              <div>
                <strong>{name(s)}</strong>
                <span>
                  {s.duration_min} {t('minutes')} · {counts.get(s.id) ?? 0} {t('countBookings')}
                  {!s.active && ` · ${t('inactive')}`}
                </span>
              </div>
              <strong className="bk-price">{money(s.price_cents, locale, true)}</strong>
              {!data.readOnly && (
                <button className="bk-icon" aria-label={t('editService')} onClick={() => onService(s)}>
                  <Pencil size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title={t('hours')} action={<span className="bk-muted bk-small">{t('hoursHint')}</span>}>
        <ul className="bk-list bk-hours">
          {weekdayOrder.map((weekday) => {
            const row = data.opening_hours.find((h) => h.weekday === weekday)
            return (
              <li key={weekday} className={row ? '' : 'is-paused'}>
                <div>
                  <strong>{weekdayName(weekday, locale)}</strong>
                </div>
                <span className="bk-price">{row ? `${row.opens}–${row.closes}` : t('closed')}</span>
                {!data.readOnly && (
                  <button className="bk-icon" aria-label={t('editHours')} onClick={() => onHours(weekday)}>
                    <Pencil size={14} />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </Panel>
      <Panel
        title={t('resources')}
        className="bk-span-3"
        action={
          !data.readOnly && (
            <button onClick={() => onResource()}>
              <Plus size={15} />
              {t('addResource')}
            </button>
          )
        }
      >
        <ul className="bk-resource-cards">
          {view.resources.map((r) => (
            <li key={r.id} className={r.active ? '' : 'is-paused'} style={tint(r.color)}>
              <span className="bk-avatar" style={{ background: r.color }}>
                {initials(name(r))}
              </span>
              <div>
                <strong>{name(r)}</strong>
                <span>
                  {t(r.kind)} · {r.active ? t('active') : t('inactive')}
                </span>
              </div>
              {!data.readOnly && (
                <button className="bk-icon" aria-label={t('editResource')} onClick={() => onResource(r)}>
                  <Pencil size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}

function Dashboard({ data, view, locale, t, name, describe, onOpen, onSeeSchedule }: Shared & { onOpen: (b: Booking) => void; onSeeSchedule: () => void }) {
  const anchor = view.anchor
  const today = view.sorted.filter((b) => holdsSlot(b) && dayOf(b.starts_at) === anchor)
  const upcoming = today.find((b) => b.status === 'confirmed' && b.starts_at >= view.now)
  const week = weekDays(anchor)
  const usage = utilization(data, week)
  const weekBooked = usage.reduce((sum, u) => sum + u.booked, 0)
  const weekOpen = usage.reduce((sum, u) => sum + u.open, 0)
  const month = anchor.slice(0, 7)
  const monthEnd = addDays(`${addDays(`${month}-28`, 4).slice(0, 7)}-01`, -1)
  const lastMonth = addDays(`${month}-01`, -1).slice(0, 7)
  const missed = noShowRate(data.bookings, addDays(anchor, -30), addDays(anchor, -1))
  const history = Array.from({ length: 28 }, (_, i) => addDays(anchor, i - 28))
  const heat = busyHours(data.bookings, history)
  // The weeks the four-week history touches, through this one.
  const weeks = Array.from({ length: 5 }, (_, i) => addDays(weekStart(anchor), (i - 4) * 7))
  const weekly = weeks.map((start) => ({ start, cents: revenue(data.bookings, start, addDays(start, 6)) }))
  return (
    <>
      <section className="bk-kpis">
        <Kpi
          label={t('todayBookings')}
          value={String(today.length)}
          hint={upcoming ? `${t('nextAt')} ${timeOf(upcoming.starts_at)} · ${describe(upcoming).customer?.name ?? ''}` : t('allDone')}
        />
        <Kpi label={t('weekUtilization')} value={weekOpen ? `${Math.round((weekBooked / weekOpen) * 100)}%` : '—'} hint={`${Math.round(weekBooked / 60)} ${t('hoursShort')} ${t('booked')}`} />
        <Kpi
          label={t('monthRevenue')}
          value={money(revenue(data.bookings, `${month}-01`, monthEnd), locale, true)}
          hint={`${dayLabel(`${lastMonth}-01`, locale, { month: 'long' })} ${money(revenue(data.bookings, `${lastMonth}-01`, addDays(`${month}-01`, -1)), locale, true)}`}
        />
        <Kpi
          label={t('noShowRate')}
          value={missed ? `${(missed.rate * 100).toFixed(1)}%` : '—'}
          hint={missed ? `${missed.missed} / ${missed.due} · ${t('last30')}` : t('last30')}
          tone={missed && missed.rate > 0.1 ? 'warn' : undefined}
        />
      </section>
      <div className="bk-grid">
        <Panel
          title={t('todayBookings')}
          action={
            <button className="bk-link" onClick={onSeeSchedule}>
              {t('schedule')}
            </button>
          }
        >
          {today.length === 0 ? (
            <p className="bk-empty">{hoursOn(data.opening_hours, anchor) ? t('noBookings') : t('closedToday')}</p>
          ) : (
            <ul className="bk-agenda">
              {today.map((b) => {
                const { resource, service, customer } = describe(b)
                return (
                  <li key={b.id}>
                    <button onClick={() => onOpen(b)} style={tint(resource?.color ?? resourceColors[0])}>
                      <span className="bk-agenda-time">{timeOf(b.starts_at)}</span>
                      <span className="bk-agenda-what">
                        <strong>{customer?.name}</strong>
                        <em>
                          {name(service)} · {name(resource)}
                        </em>
                      </span>
                      <StatusPill booking={b} now={view.now} t={t} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
        <Panel title={t('byResource')} className="bk-span-2">
          <ul className="bk-bars">
            {usage.map((u) => (
              <li key={u.resource.id} style={tint(u.resource.color)}>
                <span>{name(u.resource)}</span>
                <div className="bk-bar">
                  <i style={{ width: `${Math.max(1, u.ratio * 100)}%` }} />
                </div>
                <strong>{Math.round(u.ratio * 100)}%</strong>
                <em>
                  {Math.round(u.booked / 60)} {t('of')} {Math.round(u.open / 60)} {t('hoursShort')}
                </em>
              </li>
            ))}
          </ul>
          <h3 className="bk-subhead">{t('weeklyRevenue')}</h3>
          <RevenueBars weeks={weekly} current={weekStart(anchor)} locale={locale} />
        </Panel>
        <Panel title={t('busiestHours')} className="bk-span-3">
          <p className="bk-muted bk-small">{t('busiestHint')}</p>
          <Heatmap grid={heat} hours={data.opening_hours} capacity={Math.max(1, usage.length)} locale={locale} t={t} />
        </Panel>
      </div>
    </>
  )
}

function RevenueBars({ weeks, current, locale }: { weeks: { start: string; cents: number }[]; current: string; locale: Locale }) {
  const max = Math.max(1, ...weeks.map((w) => w.cents))
  return (
    <div className="bk-columns" role="img">
      {weeks.map((w) => (
        <div key={w.start} className={w.start === current ? 'is-current' : ''}>
          <strong>{money(w.cents, locale, true)}</strong>
          <i style={{ height: `${Math.max(2, (w.cents / max) * 100)}%` }} />
          <span>{dayLabel(w.start, locale, { month: 'short', day: 'numeric' })}</span>
        </div>
      ))}
    </div>
  )
}

/** Weekdays down, hours across; each cell is the share of the studio's capacity that was booked. */
function Heatmap({ grid, hours, capacity, locale, t }: { grid: number[][]; hours: BookingData['opening_hours']; capacity: number; locale: Locale; t: T }) {
  const days = weekdayOrder.filter((d) => hours.some((h) => h.weekday === d) || grid[d].some(Boolean))
  const busy = days.flatMap((d) => grid[d].flatMap((v, h) => (v ? [h] : [])))
  const first = Math.min(...hours.map((h) => Math.floor((parseClock(h.opens) ?? 1440) / 60)), ...busy)
  const last = Math.max(...hours.map((h) => Math.ceil((parseClock(h.closes) ?? 0) / 60) - 1), ...busy)
  if (!days.length || !(last >= first)) return null
  const columns = Array.from({ length: last - first + 1 }, (_, i) => first + i)
  // Four weeks of history: a full cell is every resource booked for the whole hour, every week.
  const share = (minutes: number) => Math.min(1, minutes / (4 * 60 * capacity))
  return (
    <div className="bk-heat-scroll">
      <div className="bk-heat" style={{ '--hours': columns.length } as CSSProperties} role="img">
        <span />
        {columns.map((h) => (
          <span key={h} className="bk-heat-hour">
            {clock(h * 60)}
          </span>
        ))}
        {days.map((d) => (
          <Fragment key={d}>
            <span className="bk-heat-day">{weekdayName(d, locale, 'short')}</span>
            {columns.map((h) => {
              const value = share(grid[d][h] ?? 0)
              return (
                <i
                  key={h}
                  title={`${weekdayName(d, locale, 'short')} ${clock(h * 60)} · ${Math.round(value * 100)}%`}
                  style={value ? { opacity: 0.14 + value * 0.86 } : undefined}
                  className={value ? 'is-busy' : ''}
                />
              )
            })}
          </Fragment>
        ))}
      </div>
      <div className="bk-heat-key">
        {t('quiet')}
        {[0.2, 0.4, 0.6, 0.8, 1].map((v) => (
          <i key={v} style={{ opacity: v }} />
        ))}
        {t('busy')}
      </div>
    </div>
  )
}

function BookingDetail({
  data,
  view,
  locale,
  t,
  name,
  describe,
  booking,
  busy,
  onStatus,
  onEdit,
}: Shared & { booking: Booking; busy: boolean; onStatus: (s: BookingStatus) => void; onEdit: () => void }) {
  const { resource, service, customer } = describe(booking)
  return (
    <div className="bk-detail" style={tint(resource?.color ?? resourceColors[0])}>
      <div className="bk-detail-head">
        <div>
          <p>{dayLabel(dayOf(booking.starts_at), locale, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h3>{span(booking)}</h3>
        </div>
        <StatusPill booking={booking} now={view.now} t={t} />
      </div>
      <dl>
        <dt>{t('customer')}</dt>
        <dd>
          <strong>{customer?.name ?? '—'}</strong>
          {customer?.phone && <span>{customer.phone}</span>}
        </dd>
        <dt>{t('service')}</dt>
        <dd>
          {name(service)} · {minutesBetween(booking.starts_at, booking.ends_at)} {t('minutes')}
        </dd>
        <dt>{t('with')}</dt>
        <dd className="bk-with">
          <i />
          {name(resource)}
        </dd>
        <dt>{t('price')}</dt>
        <dd>{money(booking.price_cents, locale)}</dd>
        {booking.notes && (
          <>
            <dt>{t('notes')}</dt>
            <dd>{booking.notes}</dd>
          </>
        )}
      </dl>
      {!data.readOnly && (
        <div className="bk-actions bk-detail-actions">
          {booking.status === 'confirmed' && (
            <button disabled={busy} onClick={onEdit}>
              <Pencil size={15} />
              {t('edit')}
            </button>
          )}
          <StatusActions booking={booking} busy={busy} onStatus={onStatus} t={t} labels />
        </div>
      )}
    </div>
  )
}

function BookingForm({
  data,
  view,
  locale,
  t,
  name,
  form,
  busy,
  error,
  onSubmit,
  onCancel,
}: Shared & {
  form: Extract<Form, { type: 'book' }>
  busy: boolean
  error: string
  onSubmit: (actions: BookingAction[]) => void
  onCancel: () => void
}) {
  const editing = form.booking
  const services = view.services.filter((s) => s.active || s.id === editing?.service_id)
  const resources = view.resources.filter((r) => r.active || r.id === editing?.resource_id)
  const [serviceId, setServiceId] = useState(editing?.service_id ?? services[0]?.id ?? '')
  const [resourceId, setResourceId] = useState(editing?.resource_id ?? form.resourceId ?? resources[0]?.id ?? '')
  const [day, setDay] = useState(form.day)
  const service = view.lookup.services.get(serviceId)
  const duration = service?.duration_min ?? 60
  const firstFree = freeStarts(data.bookings, data.opening_hours, resourceId, form.day, duration)[0]
  const [time, setTime] = useState(clock(editing ? minutesOf(editing.starts_at) : (form.start ?? firstFree ?? 9 * 60)))
  const [mode, setMode] = useState<'existing' | 'new'>(data.customers.length ? 'existing' : 'new')
  const [customerId, setCustomerId] = useState(editing?.customer_id ?? form.forCustomer ?? '')
  const [customerName, setCustomerName] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState(editing?.notes ?? '')
  const minutes = parseClock(time)
  const startsAt = minutes === null || !day ? '' : atLocal(day, minutes)
  const endsAt = startsAt ? endFor(startsAt, duration) : ''
  const clash = startsAt ? findConflict(data.bookings, { id: editing?.id, resource_id: resourceId, starts_at: startsAt, ends_at: endsAt }) : undefined
  const open = day ? hoursOn(data.opening_hours, day) : null
  const outside = minutes !== null && (!open || minutes < open.opens || minutes + duration > open.closes)
  // Earlier today is not on offer, though a time can still be typed in (a walk-in logged late).
  const free = day ? freeStarts(data.bookings, data.opening_hours, resourceId, day, duration, editing?.id).filter((m) => atLocal(day, m) >= view.now) : []
  const customers = [...data.customers].sort((a, b) => a.name.localeCompare(b.name, tag(locale)))
  const isNew = !editing && mode === 'new'
  const actions: BookingAction[] = editing
    ? [{ type: 'edit-booking', id: editing.id, resourceId, serviceId, startsAt, notes: notes.trim() }]
    : [
        ...(isNew ? [{ type: 'save-customer' as const, id: form.customerId, name: customerName, phone, email: '', notes: '' }] : []),
        { type: 'book', id: form.id, resourceId, serviceId, customerId: isNew ? form.customerId : customerId, startsAt, notes: notes.trim() },
      ]
  const problem = actions.map(problemWith).find(Boolean) ?? null
  const [tried, setTried] = useState(false)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (!problem && !clash) onSubmit(actions)
  }
  const clashWith = clash ? view.lookup.customers.get(clash.customer_id)?.name : ''
  return (
    <form className="bk-form" onSubmit={submit}>
      <div className="bk-form-grid">
        <Field label={t('service')}>
          <Choice
            label={t('service')}
            value={serviceId}
            onChange={setServiceId}
            options={services.map((s): [string, string] => [s.id, `${name(s)} · ${s.duration_min} ${t('minutes')} · ${money(s.price_cents, locale, true)}`])}
          />
        </Field>
        <Field label={t('resource')}>
          <Choice label={t('resource')} value={resourceId} onChange={setResourceId} options={resources.map((r): [string, string] => [r.id, name(r)])} />
        </Field>
        <Field label={t('date')}>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} required />
        </Field>
        <Field label={t('start')}>
          <input type="time" step={SLOT_MINUTES * 60} value={time} onChange={(e) => setTime(e.target.value)} required />
        </Field>
      </div>
      <div className="bk-when-summary">
        <Clock3 size={15} />
        <span>
          {startsAt ? `${clock(minutes!)}–${timeOf(endsAt)}` : '—'} · {duration} {t('minutes')}
        </span>
        <strong>{service ? money(editing && editing.service_id === serviceId ? editing.price_cents : service.price_cents, locale) : ''}</strong>
      </div>
      {clash ? (
        <p className="bk-error" role="alert">
          <strong>
            {t('clashWith')}: {span(clash)} · {clashWith}
          </strong>{' '}
          {t('clashHint')}
        </p>
      ) : (
        outside && <p className="bk-warn">{t('outsideHours')}</p>
      )}
      <div className="bk-field">
        <span>{t('freeSlots')}</span>
        {free.length === 0 ? (
          <p className="bk-muted bk-small">{t('noFreeSlots')}</p>
        ) : (
          <div className="bk-free">
            {free.map((m) => (
              <button type="button" key={m} aria-pressed={m === minutes} onClick={() => setTime(clock(m))}>
                {clock(m)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="bk-field">
        <span>{t('customer')}</span>
        {editing ? (
          <p className="bk-static">{view.lookup.customers.get(editing.customer_id)?.name}</p>
        ) : (
          <>
            <div className="bk-segments">
              {(['existing', 'new'] as const).map((m) => (
                <button type="button" key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
                  {t(m === 'existing' ? 'existingCustomer' : 'newCustomer')}
                </button>
              ))}
            </div>
            {mode === 'existing' ? (
              <Choice
                label={t('customer')}
                value={customerId}
                onChange={setCustomerId}
                placeholder={t('chooseCustomer')}
                options={customers.map((c): [string, string] => [c.id, c.phone ? `${c.name} · ${c.phone}` : c.name])}
              />
            ) : (
              <div className="bk-form-grid">
                <input aria-label={t('customerName')} placeholder={t('customerName')} value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
                <input aria-label={t('phone')} placeholder={t('phone')} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
              </div>
            )}
          </>
        )}
      </div>
      <Field label={t('notes')}>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Actions t={t} busy={busy} error={error || (tried && problem) || ''} onCancel={onCancel} submit={editing ? 'save' : 'book'} disabled={!!clash} />
    </form>
  )
}

function CustomerForm({ id, customer, t, busy, error, onSubmit, onCancel }: { id: string; customer?: Customer; t: T; busy: boolean; error: string; onSubmit: (a: BookingAction) => void; onCancel: () => void }) {
  const [name, setName] = useState(customer?.name ?? '')
  const [phone, setPhone] = useState(customer?.phone ?? '')
  const [email, setEmail] = useState(customer?.email ?? '')
  const [notes, setNotes] = useState(customer?.notes ?? '')
  const [problem, setProblem] = useState('')
  const action: BookingAction = { type: 'save-customer', id, name, phone, email, notes }
  return (
    <form
      className="bk-form"
      onSubmit={(e) => {
        e.preventDefault()
        const p = problemWith(action)
        setProblem(p ?? '')
        if (!p) onSubmit(action)
      }}
    >
      <Field label={t('customerName')}>
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
      </Field>
      <div className="bk-form-grid">
        <Field label={t('phone')}>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" maxLength={40} />
        </Field>
        <Field label={t('email')}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} />
        </Field>
      </div>
      <Field label={t('notes')}>
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Actions t={t} busy={busy} error={error || problem} onCancel={onCancel} />
    </form>
  )
}

function ServiceForm({ id, service, t, busy, error, onSubmit, onCancel }: { id: string; service?: Service; t: T; busy: boolean; error: string; onSubmit: (a: BookingAction) => void; onCancel: () => void }) {
  const [name, setName] = useState(service?.name ?? '')
  const [nameEn, setNameEn] = useState(service?.name_en ?? '')
  const [duration, setDuration] = useState(String(service?.duration_min ?? 60))
  const [price, setPrice] = useState(service ? (service.price_cents / 100).toFixed(2).replace(/\.00$/, '') : '')
  const [active, setActive] = useState(service?.active ?? true)
  const [problem, setProblem] = useState('')
  const priceCents = parsePrice(price)
  const action: BookingAction = { type: 'save-service', id, name, name_en: nameEn, durationMin: Number(duration), priceCents: priceCents ?? -1, active }
  return (
    <form
      className="bk-form"
      onSubmit={(e) => {
        e.preventDefault()
        const p = problemWith(action)
        setProblem(p ?? '')
        if (!p) onSubmit(action)
      }}
    >
      <div className="bk-form-grid">
        <Field label={t('name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </Field>
        <Field label={t('nameEn')}>
          <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={120} />
        </Field>
        <Field label={`${t('duration')} (${t('minutes')})`} hint={t('durationHint')}>
          <input type="number" min={5} max={480} step={5} value={duration} onChange={(e) => setDuration(e.target.value)} required />
        </Field>
        <Field label={`${t('price')} ($)`}>
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" required />
        </Field>
      </div>
      <Toggle label={t('active')} hint={t('inactiveHint')} checked={active} onChange={setActive} />
      <Actions t={t} busy={busy} error={error || problem} onCancel={onCancel} />
    </form>
  )
}

function ResourceForm({ id, resource, used, t, busy, error, onSubmit, onCancel }: { id: string; resource?: Resource; used: string[]; t: T; busy: boolean; error: string; onSubmit: (a: BookingAction) => void; onCancel: () => void }) {
  const [name, setName] = useState(resource?.name ?? '')
  const [nameEn, setNameEn] = useState(resource?.name_en ?? '')
  const [kind, setKind] = useState<ResourceKind>(resource?.kind ?? 'staff')
  const [color, setColor] = useState(resource?.color ?? resourceColors.find((c) => !used.includes(c)) ?? resourceColors[0])
  const [active, setActive] = useState(resource?.active ?? true)
  const [problem, setProblem] = useState('')
  const action: BookingAction = { type: 'save-resource', id, name, name_en: nameEn, kind, color, active }
  return (
    <form
      className="bk-form"
      onSubmit={(e) => {
        e.preventDefault()
        const p = problemWith(action)
        setProblem(p ?? '')
        if (!p) onSubmit(action)
      }}
    >
      <div className="bk-form-grid">
        <Field label={t('name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </Field>
        <Field label={t('nameEn')}>
          <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={120} />
        </Field>
      </div>
      <div className="bk-field">
        <span>{t('kind')}</span>
        <div className="bk-segments">
          {(['staff', 'room'] as const).map((k) => (
            <button type="button" key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {t(k)}
            </button>
          ))}
        </div>
      </div>
      <div className="bk-field">
        <span>{t('color')}</span>
        <div className="bk-colors">
          {resourceColors.map((c) => (
            <button type="button" key={c} aria-label={c} aria-pressed={color === c} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
      </div>
      <Toggle label={t('active')} hint={t('inactiveHint')} checked={active} onChange={setActive} />
      <Actions t={t} busy={busy} error={error || problem} onCancel={onCancel} />
    </form>
  )
}

function HoursForm({ weekday, current, t, busy, error, onSubmit, onCancel }: { weekday: number; current?: BookingData['opening_hours'][number]; t: T; busy: boolean; error: string; onSubmit: (a: BookingAction) => void; onCancel: () => void }) {
  const [isOpen, setOpen] = useState(!!current)
  const [opens, setOpens] = useState(current?.opens ?? '09:00')
  const [closes, setCloses] = useState(current?.closes ?? '18:00')
  const [problem, setProblem] = useState('')
  const action: BookingAction = isOpen ? { type: 'set-hours', weekday, opens, closes } : { type: 'close-day', weekday }
  return (
    <form
      className="bk-form"
      onSubmit={(e) => {
        e.preventDefault()
        const p = problemWith(action)
        setProblem(p ?? '')
        if (!p) onSubmit(action)
      }}
    >
      <div className="bk-segments">
        <button type="button" aria-pressed={isOpen} onClick={() => setOpen(true)}>
          {t('open')}
        </button>
        <button type="button" aria-pressed={!isOpen} onClick={() => setOpen(false)}>
          {t('closed')}
        </button>
      </div>
      {isOpen && (
        <div className="bk-form-grid">
          <Field label={t('opens')}>
            <input type="time" step={SLOT_MINUTES * 60} value={opens} onChange={(e) => setOpens(e.target.value)} required />
          </Field>
          <Field label={t('closes')}>
            <input type="time" step={SLOT_MINUTES * 60} value={closes} onChange={(e) => setCloses(e.target.value)} required />
          </Field>
        </div>
      )}
      <p className="bk-muted bk-small">{t('hoursHint')}</p>
      <Actions t={t} busy={busy} error={error || problem} onCancel={onCancel} />
    </form>
  )
}

function Panel({ title, action, className = '', children }: { title?: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`bk-panel ${className}`}>
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

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warn' }) {
  return (
    <div className={`bk-kpi${tone ? ` is-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <em>{hint}</em>}
    </div>
  )
}

function Choice({ label, value, onChange, options, placeholder }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; placeholder?: string }) {
  return (
    <Select value={value} onValueChange={(next) => next !== null && onChange(next as string)}>
      <SelectTrigger aria-label={label} className="bk-select">
        <SelectValue>{(v) => options.find(([id]) => id === v)?.[1] ?? placeholder ?? ''}</SelectValue>
      </SelectTrigger>
      <SelectContent className="bk-select-popup" positionerClassName="bk-select-positioner">
        {options.map(([id, text]) => (
          <SelectItem key={id || 'all'} value={id}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function Modal({ title, onClose, t, wide, children }: { title: string; onClose: () => void; t: T; wide?: boolean; children: ReactNode }) {
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="bk-modal-backdrop" />
        <Dialog.Popup className={`booking-app bk-modal${wide ? ' is-wide' : ''}`}>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close className="bk-icon bk-modal-close" aria-label={t('close')}>
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
    <label className="bk-field">
      <span>{label}</span>
      {children}
      {hint && <em>{hint}</em>}
    </label>
  )
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="bk-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{label}</strong>
        <em>{hint}</em>
      </span>
    </label>
  )
}

function Actions({ t, busy, error, onCancel, submit = 'save', disabled = false }: { t: T; busy: boolean; error: string; onCancel: () => void; submit?: string; disabled?: boolean }) {
  return (
    <>
      {error && <p className="bk-error">{t(error)}</p>}
      <div className="bk-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </button>
        <button type="submit" className="bk-primary" disabled={busy || disabled}>
          {busy ? t('saving') : t(submit)}
        </button>
      </div>
    </>
  )
}
