export type Locale = 'zh' | 'en'
export type ResourceKind = 'staff' | 'room'
export type BookingStatus = 'confirmed' | 'completed' | 'cancelled' | 'no_show'
export const resourceKinds: ResourceKind[] = ['staff', 'room']
export const statuses: BookingStatus[] = ['confirmed', 'completed', 'no_show', 'cancelled']
export const bookingTables = ['resources', 'services', 'customers', 'bookings', 'opening_hours'] as const
/** The grid, the time picker and the free-slot finder all step in quarter hours. */
export const SLOT_MINUTES = 15
export const MIN_DURATION = 5
export const MAX_DURATION = 480
/** A booking may run longer than its service (an edited end), but never past this. */
export const MAX_BOOKING_HOURS = 12
export const MAX_PRICE_CENTS = 100_000_000
/** The demo seeds this many days of history before its "today". */
export const DEMO_HISTORY_DAYS = 28
export const resourceColors = ['#3d8f86', '#d27f57', '#7682c6', '#b2973f', '#bf6a86', '#4f8db8']

type RecordBase = { id: string; created_at: string }
/** Someone or something that can only do one booking at a time: a therapist, a treatment room. */
export type Resource = RecordBase & {
  name: string
  name_en: string
  kind: ResourceKind
  color: string
  active: boolean
}
export type Service = RecordBase & {
  name: string
  name_en: string
  duration_min: number
  price_cents: number
  active: boolean
}
export type Customer = RecordBase & { name: string; phone: string; email: string; notes: string }
/**
 * `starts_at` and `ends_at` are instants (timestamptz), shown in the browser's own time zone.
 * `price_cents` is what the service cost when it was booked, so a later price change does not
 * rewrite last month's revenue. The database fills both `ends_at` and `price_cents` from the
 * service when a write leaves them out.
 */
export type Booking = RecordBase & {
  resource_id: string
  service_id: string
  customer_id: string
  starts_at: string
  ends_at: string
  status: BookingStatus
  price_cents: number
  notes: string
}
/** One row per open weekday (0 = Sunday), in local business time. A missing day is closed. */
export type OpeningHours = RecordBase & { weekday: number; opens: string; closes: string }
export type BookingData = {
  readOnly: boolean
  resources: Resource[]
  services: Service[]
  customers: Customer[]
  bookings: Booking[]
  opening_hours: OpeningHours[]
}

/**
 * Every write the app makes. Each one is a single SQL statement (see `statementFor`); new rows
 * carry an id chosen by the browser, so retrying after a lost response cannot create a second row.
 */
export type BookingAction =
  | { type: 'book'; id: string; resourceId: string; serviceId: string; customerId: string; startsAt: string; notes: string }
  | { type: 'edit-booking'; id: string; resourceId: string; serviceId: string; startsAt: string; notes: string }
  | { type: 'set-status'; id: string; status: BookingStatus }
  | { type: 'save-customer'; id: string; name: string; phone: string; email: string; notes: string }
  | { type: 'save-service'; id: string; name: string; name_en: string; durationMin: number; priceCents: number; active: boolean }
  | { type: 'save-resource'; id: string; name: string; name_en: string; kind: ResourceKind; color: string; active: boolean }
  | { type: 'set-hours'; weekday: number; opens: string; closes: string }
  | { type: 'close-day'; weekday: number }

/**
 * The same shape as DataTemplateClient / DataTemplateProps in template-data.ts, spelled out here
 * because a copied app receives this file on its own as src/domain.ts.
 */
export type BookingClient = {
  read(): Promise<BookingData>
  run(action: BookingAction): Promise<void>
}
export type BookingProps = {
  client: BookingClient
  initialData?: BookingData
  initialLocale?: Locale
  locale?: Locale
  onLocaleChange?: (locale: Locale) => void
}

// ── Local calendar arithmetic. Days are 'YYYY-MM-DD' in the browser's time zone. ──

const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
export const dayOf = (iso: string) => dayKey(new Date(iso))
/** Minutes since local midnight. */
export function minutesOf(iso: string) {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}
/** The instant at `minutes` past local midnight on `day`, as an ISO string. */
export function atLocal(day: string, minutes: number) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 0, minutes).toISOString()
}
export function addDays(day: string, count: number) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + count)).toISOString().slice(0, 10)
}
export function weekdayOf(day: string) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
/** Weeks run Monday to Sunday. */
export const weekStart = (day: string) => addDays(day, -((weekdayOf(day) + 6) % 7))
export const weekDays = (day: string) => Array.from({ length: 7 }, (_, i) => addDays(weekStart(day), i))
export const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().startsWith(value)
export const minutesBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60000)
export const endFor = (startsAt: string, minutes: number) => new Date(Date.parse(startsAt) + minutes * 60000).toISOString()

/** '09:30' → 570. Anything that is not a 24-hour HH:MM clock reading is null. */
export function parseClock(text: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}
export const clock = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`

export type Window = { opens: number; closes: number }
export function hoursOn(hours: Pick<OpeningHours, 'weekday' | 'opens' | 'closes'>[], day: string): Window | null {
  const row = hours.find((h) => h.weekday === weekdayOf(day))
  const opens = row ? parseClock(row.opens) : null
  const closes = row ? parseClock(row.closes) : null
  return opens !== null && closes !== null && closes > opens ? { opens, closes } : null
}

// ── Overlap: the same rule the database enforces, so the UI can warn before it asks. ──

type Span = { starts_at: string; ends_at: string }
/** Half-open intervals: a 10:00–11:00 booking and an 11:00–12:00 one do not clash. */
export const overlaps = (a: Span, b: Span) =>
  Date.parse(a.starts_at) < Date.parse(b.ends_at) && Date.parse(b.starts_at) < Date.parse(a.ends_at)
/** A cancelled booking gives its slot back; a no-show still used it up. */
export const holdsSlot = (b: Pick<Booking, 'status'>) => b.status !== 'cancelled'

export type Candidate = Span & { resource_id: string; id?: string }
export function findConflict<B extends Pick<Booking, 'id' | 'resource_id' | 'status' | 'starts_at' | 'ends_at'>>(
  bookings: B[],
  candidate: Candidate,
): B | undefined {
  return bookings.find(
    (b) => b.id !== candidate.id && b.resource_id === candidate.resource_id && holdsSlot(b) && overlaps(b, candidate),
  )
}

/**
 * Start times (minutes past midnight) on `day` where a `duration`-minute booking fits inside the
 * opening hours without touching another booking for the resource. `ignoreId` leaves out the
 * booking being moved, so it can keep or shift its own slot.
 */
export function freeStarts(
  bookings: Pick<Booking, 'id' | 'resource_id' | 'status' | 'starts_at' | 'ends_at'>[],
  hours: Pick<OpeningHours, 'weekday' | 'opens' | 'closes'>[],
  resourceId: string,
  day: string,
  duration: number,
  ignoreId?: string,
) {
  const open = hoursOn(hours, day)
  if (!open || duration <= 0) return []
  const starts: number[] = []
  for (let m = open.opens; m + duration <= open.closes; m += SLOT_MINUTES) {
    const starts_at = atLocal(day, m)
    const candidate = { id: ignoreId, resource_id: resourceId, starts_at, ends_at: endFor(starts_at, duration) }
    if (!findConflict(bookings, candidate)) starts.push(m)
  }
  return starts
}

/**
 * The hours a day grid shows: the opening hours, widened to whole hours around any booking that
 * falls outside them (an after-hours appointment, or a viewer in another time zone).
 */
export function dayRange(open: Window | null, bookings: Span[]): Window {
  let start = open?.opens ?? 9 * 60
  let end = open?.closes ?? 18 * 60
  for (const b of bookings) {
    const from = minutesOf(b.starts_at)
    const length = minutesBetween(b.starts_at, b.ends_at)
    start = Math.min(start, from)
    end = Math.max(end, Math.min(24 * 60, from + length))
  }
  return { opens: Math.floor(start / 60) * 60, closes: Math.min(24 * 60, Math.ceil(end / 60) * 60) }
}

// ── Figures for the dashboard. All of them skip cancelled bookings. ──

export function openMinutes(hours: Pick<OpeningHours, 'weekday' | 'opens' | 'closes'>[], days: string[]) {
  return days.reduce((sum, day) => {
    const open = hoursOn(hours, day)
    return sum + (open ? open.closes - open.opens : 0)
  }, 0)
}

export type Utilization = { resource: Resource; booked: number; open: number; ratio: number }
/** Booked minutes over open minutes, per active resource. No-shows count: the slot was held. */
export function utilization(data: Pick<BookingData, 'resources' | 'bookings' | 'opening_hours'>, days: string[]): Utilization[] {
  const inRange = new Set(days)
  const open = openMinutes(data.opening_hours, days)
  const booked = new Map<string, number>()
  for (const b of data.bookings)
    if (holdsSlot(b) && inRange.has(dayOf(b.starts_at)))
      booked.set(b.resource_id, (booked.get(b.resource_id) ?? 0) + minutesBetween(b.starts_at, b.ends_at))
  return data.resources
    .filter((r) => r.active)
    .map((resource) => {
      const minutes = booked.get(resource.id) ?? 0
      return { resource, booked: minutes, open, ratio: open ? Math.min(1, minutes / open) : 0 }
    })
}

/** Takings from completed bookings whose day falls in [from, to], at the price each was booked at. */
export const revenue = (bookings: Pick<Booking, 'status' | 'starts_at' | 'price_cents'>[], from: string, to: string) =>
  bookings
    .filter((b) => b.status === 'completed' && dayOf(b.starts_at) >= from && dayOf(b.starts_at) <= to)
    .reduce((sum, b) => sum + b.price_cents, 0)

/** No-shows over bookings that were due to happen; null when none were. */
export function noShowRate(bookings: Pick<Booking, 'status' | 'starts_at'>[], from: string, to: string) {
  let due = 0
  let missed = 0
  for (const b of bookings) {
    const day = dayOf(b.starts_at)
    if (day < from || day > to || (b.status !== 'completed' && b.status !== 'no_show')) continue
    due++
    if (b.status === 'no_show') missed++
  }
  return due ? { rate: missed / due, missed, due } : null
}

/** Booked minutes by weekday (0 = Sunday) and hour of day, from the bookings that start on `days`. */
export function busyHours(bookings: Pick<Booking, 'status' | 'starts_at' | 'ends_at'>[], days: string[]) {
  const inRange = new Set(days)
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
  for (const b of bookings) {
    const day = dayOf(b.starts_at)
    if (!holdsSlot(b) || !inRange.has(day)) continue
    const from = minutesOf(b.starts_at)
    const to = Math.min(24 * 60, from + minutesBetween(b.starts_at, b.ends_at))
    for (let m = from; m < to; ) {
      const hourEnd = (Math.floor(m / 60) + 1) * 60
      const next = Math.min(hourEnd, to)
      grid[weekdayOf(day)][Math.floor(m / 60)] += next - m
      m = next
    }
  }
  return grid
}

export type CustomerSummary = {
  visits: number
  spent: number
  noShows: number
  lastVisit: Booking | undefined
  nextVisit: Booking | undefined
  history: Booking[]
}
/** A customer's bookings newest first, with what they add up to as of `now`. */
export function customerSummary(bookings: Booking[], customerId: string, now: string): CustomerSummary {
  const history = bookings
    .filter((b) => b.customer_id === customerId)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
  const completed = history.filter((b) => b.status === 'completed')
  const upcoming = history.filter((b) => b.status === 'confirmed' && Date.parse(b.starts_at) >= Date.parse(now))
  return {
    visits: completed.length,
    spent: completed.reduce((sum, b) => sum + b.price_cents, 0),
    noShows: history.filter((b) => b.status === 'no_show').length,
    lastVisit: completed[0],
    nextVisit: upcoming[upcoming.length - 1],
    history,
  }
}

/** Still marked confirmed after it ended: the front desk has not checked it out yet. */
export const awaitingCheckout = (b: Pick<Booking, 'status' | 'ends_at'>, now: string) =>
  b.status === 'confirmed' && Date.parse(b.ends_at) <= Date.parse(now)

/**
 * The read-only gallery demo is seeded once and then kept, so its bookings drift into the past.
 * It opens on the day it was seeded instead (the day after its history), which is today for a
 * fresh demo; a real copy always opens on today.
 */
export function anchorDay(data: Pick<BookingData, 'readOnly' | 'bookings'>, today: string) {
  if (!data.readOnly || !data.bookings.length) return today
  const first = data.bookings.reduce((min, b) => (b.starts_at < min ? b.starts_at : min), data.bookings[0].starts_at)
  return addDays(dayOf(first), DEMO_HISTORY_DAYS)
}

// ── Input checks shared by the forms and `statementFor`. Each returns a label key or null. ──

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isId = (v: unknown) => typeof v === 'string' && UUID.test(v)
const isInstant = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const text = (v: unknown, max: number, required = false) =>
  typeof v === 'string' && v.length <= max && (!required || v.trim().length > 0)
export const isDuration = (n: unknown): n is number =>
  Number.isInteger(n) && (n as number) >= MIN_DURATION && (n as number) <= MAX_DURATION && (n as number) % 5 === 0
export const isPrice = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= MAX_PRICE_CENTS
export const isColor = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)

export function problemWith(action: BookingAction): string | null {
  switch (action.type) {
    case 'book':
    case 'edit-booking':
      if (![action.id, action.resourceId, action.serviceId].every(isId)) return 'invalid_input'
      if (action.type === 'book' && !isId(action.customerId)) return 'customer_required'
      if (!isInstant(action.startsAt)) return 'invalid_time'
      return text(action.notes, 2000) ? null : 'invalid_input'
    case 'set-status':
      return isId(action.id) && statuses.includes(action.status) ? null : 'invalid_input'
    case 'save-customer':
      if (!isId(action.id)) return 'invalid_input'
      if (!text(action.name, 120, true)) return 'name_required'
      return text(action.phone, 40) && text(action.email, 200) && text(action.notes, 2000) ? null : 'invalid_input'
    case 'save-service':
      if (!isId(action.id) || !text(action.name_en, 120)) return 'invalid_input'
      if (!text(action.name, 120, true)) return 'name_required'
      if (!isDuration(action.durationMin)) return 'invalid_duration'
      return isPrice(action.priceCents) ? null : 'invalid_price'
    case 'save-resource':
      if (!isId(action.id) || !text(action.name_en, 120)) return 'invalid_input'
      if (!text(action.name, 120, true)) return 'name_required'
      return resourceKinds.includes(action.kind) && isColor(action.color) ? null : 'invalid_input'
    case 'set-hours': {
      const opens = parseClock(action.opens)
      const closes = parseClock(action.closes)
      if (!Number.isInteger(action.weekday) || action.weekday < 0 || action.weekday > 6) return 'invalid_input'
      return opens !== null && closes !== null && closes > opens ? null : 'invalid_hours'
    }
    case 'close-day':
      return Number.isInteger(action.weekday) && action.weekday >= 0 && action.weekday <= 6 ? null : 'invalid_input'
  }
}

// ── SQL. Copies run these through sql() in src/lib/lovbase.ts, with the project schema on the
// search_path. One statement each; the triggers installed with the template do the rest. ──

export type Statement = { sql: string; params: unknown[] }

/**
 * Reads in the shape the gallery preview gets from TemplatesService.readTables: numerics cast to
 * float8 so they arrive as numbers. Only the latest 1,000 bookings are read, the SQL API's limit;
 * an older history stays in the database and in the SQL console.
 */
export const readStatements: Record<(typeof bookingTables)[number], string> = {
  resources: 'SELECT id, created_at, name, name_en, kind, color, active FROM resources ORDER BY created_at, id',
  services:
    'SELECT id, created_at, name, name_en, duration_min::float8 AS duration_min, price_cents::float8 AS price_cents, active FROM services ORDER BY created_at, id',
  customers: 'SELECT id, created_at, name, phone, email, notes FROM customers ORDER BY created_at, id',
  bookings:
    'SELECT id, created_at, resource_id, service_id, customer_id, starts_at, ends_at, status, price_cents::float8 AS price_cents, notes FROM bookings ORDER BY starts_at DESC LIMIT 1000',
  opening_hours: 'SELECT id, created_at, weekday::int AS weekday, opens, closes FROM opening_hours ORDER BY weekday',
}

export function statementFor(action: BookingAction): Statement {
  const problem = problemWith(action)
  if (problem) throw new Error(problem)
  switch (action.type) {
    // ends_at and price_cents are left to the trigger, which reads them off the service. ON
    // CONFLICT makes a retry harmless: the overlap check skips the row's own id.
    case 'book':
      return {
        sql: 'INSERT INTO bookings (id, resource_id, service_id, customer_id, starts_at, notes) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
        params: [action.id, action.resourceId, action.serviceId, action.customerId, action.startsAt, action.notes],
      }
    // Clearing ends_at has the trigger recompute it; the price is kept unless the service changed.
    case 'edit-booking':
      return {
        sql: 'UPDATE bookings SET resource_id = $2, service_id = $3, starts_at = $4, ends_at = NULL, price_cents = CASE WHEN service_id = $3 THEN price_cents END, notes = $5 WHERE id = $1',
        params: [action.id, action.resourceId, action.serviceId, action.startsAt, action.notes],
      }
    case 'set-status':
      return { sql: 'UPDATE bookings SET status = $2 WHERE id = $1', params: [action.id, action.status] }
    case 'save-customer':
      return {
        sql: 'INSERT INTO customers (id, name, phone, email, notes) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, email = EXCLUDED.email, notes = EXCLUDED.notes',
        params: [action.id, action.name.trim(), action.phone.trim(), action.email.trim(), action.notes],
      }
    case 'save-service':
      return {
        sql: 'INSERT INTO services (id, name, name_en, duration_min, price_cents, active) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, name_en = EXCLUDED.name_en, duration_min = EXCLUDED.duration_min, price_cents = EXCLUDED.price_cents, active = EXCLUDED.active',
        params: [action.id, action.name.trim(), action.name_en.trim(), action.durationMin, action.priceCents, action.active],
      }
    case 'save-resource':
      return {
        sql: 'INSERT INTO resources (id, name, name_en, kind, color, active) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, name_en = EXCLUDED.name_en, kind = EXCLUDED.kind, color = EXCLUDED.color, active = EXCLUDED.active',
        params: [action.id, action.name.trim(), action.name_en.trim(), action.kind, action.color.toLowerCase(), action.active],
      }
    case 'set-hours':
      return {
        sql: 'INSERT INTO opening_hours (weekday, opens, closes) VALUES ($1, $2, $3) ON CONFLICT (weekday) DO UPDATE SET opens = EXCLUDED.opens, closes = EXCLUDED.closes',
        params: [action.weekday, action.opens, action.closes],
      }
    case 'close-day':
      return { sql: 'DELETE FROM opening_hours WHERE weekday = $1', params: [action.weekday] }
  }
}

/**
 * Turns an error from the SQL API into a label key. The triggers raise their own codes by name
 * (booking_overlap, resource_inactive, …); anything else falls back to a generic message.
 */
export function errorKey(message: string) {
  const raised = ['booking_overlap', 'resource_inactive', 'service_inactive', 'booking_isolation', 'read_only'].find((key) =>
    message.includes(key),
  )
  if (raised) return raised
  if (/permission denied|read-only transaction/i.test(message)) return 'read_only'
  if (/foreign key/i.test(message)) return 'record_unavailable'
  if (/check constraint|not-null|invalid input/i.test(message)) return 'invalid_input'
  return /^[a-z_]+$/.test(message) ? message : 'generic_error'
}

export const localized = (value: { name: string; name_en: string }, locale: Locale) =>
  locale === 'en' ? value.name_en || value.name : value.name

/** Prices are CNY; `whole` drops the fen for at-a-glance figures. */
export function money(cents: number, locale: Locale, whole = false) {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    style: 'currency',
    currency: 'CNY',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100)
}

/** Parses "380" or "1,280.50" into cents. Returns null for anything that is not a plain amount. */
export function parsePrice(input: string): number | null {
  const clean = input.replace(/[,\s，¥]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null
  const [whole, fraction = ''] = clean.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return isPrice(cents) ? cents : null
}
