import { describe, expect, test } from 'bun:test'
import {
  addDays,
  anchorDay,
  atLocal,
  awaitingCheckout,
  busyHours,
  clock,
  customerSummary,
  dayOf,
  dayRange,
  endFor,
  errorKey,
  findConflict,
  freeStarts,
  hoursOn,
  minutesOf,
  noShowRate,
  parseClock,
  parsePrice,
  problemWith,
  readStatements,
  revenue,
  statementFor,
  utilization,
  weekDays,
  weekStart,
  type Booking,
  type BookingStatus,
  type OpeningHours,
  type Resource,
} from '../src/booking'

// 2026-11-02 is a Monday. Times are built with atLocal, so the suite passes in any time zone.
const day = '2026-11-02'
const hours: OpeningHours[] = [1, 2, 3, 4, 5].map((weekday) => ({ id: `h${weekday}`, created_at: '', weekday, opens: '09:00', closes: '18:00' }))
hours.push({ id: 'h6', created_at: '', weekday: 6, opens: '10:00', closes: '14:00' })
const resource = (id: string, active = true): Resource => ({ id, created_at: '', name: id, name_en: id, kind: 'staff', color: '#3d8f86', active })
let n = 0
const booking = (resourceId: string, on: string, from: string, to: string, status: BookingStatus = 'confirmed', extra: Partial<Booking> = {}): Booking => ({
  id: `b${++n}`,
  created_at: '',
  resource_id: resourceId,
  service_id: 's',
  customer_id: 'c1',
  starts_at: atLocal(on, parseClock(from)!),
  ends_at: atLocal(on, parseClock(to)!),
  status,
  price_cents: 30_000,
  notes: '',
  ...extra,
})
const uuid = (k: number) => `00000000-0000-4000-8000-${String(k).padStart(12, '0')}`

describe('calendar arithmetic', () => {
  test('days, weeks and clocks', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(weekStart('2026-11-08')).toBe('2026-11-02')
    expect(weekStart(day)).toBe(day)
    expect(weekDays('2026-11-04')).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'])
    expect(parseClock('09:30')).toBe(570)
    expect(parseClock('24:00')).toBeNull()
    expect(parseClock('9:30')).toBeNull()
    expect(clock(570)).toBe('09:30')
    const at = atLocal(day, 615)
    expect(dayOf(at)).toBe(day)
    expect(minutesOf(at)).toBe(615)
    expect(endFor(at, 45)).toBe(atLocal(day, 660))
  })

  test('opening hours by weekday, closed when missing or inverted', () => {
    expect(hoursOn(hours, day)).toEqual({ opens: 540, closes: 1080 })
    expect(hoursOn(hours, '2026-11-07')).toEqual({ opens: 600, closes: 840 })
    expect(hoursOn(hours, '2026-11-08')).toBeNull()
    expect(hoursOn([{ weekday: 1, opens: '18:00', closes: '09:00' }], day)).toBeNull()
  })
})

describe('overlap and free slots', () => {
  const existing = [
    booking('lin', day, '10:00', '11:00'),
    booking('lin', day, '13:00', '13:30', 'cancelled'),
    booking('zhou', day, '10:00', '12:00'),
  ]

  test('half-open intervals on the same resource clash; cancelled ones never do', () => {
    const at = (from: string, to: string, resource_id = 'lin') => ({ resource_id, starts_at: atLocal(day, parseClock(from)!), ends_at: atLocal(day, parseClock(to)!) })
    expect(findConflict(existing, at('10:30', '11:30'))?.id).toBe(existing[0].id)
    expect(findConflict(existing, at('09:00', '10:01'))?.id).toBe(existing[0].id)
    expect(findConflict(existing, at('09:30', '12:00'))?.id).toBe(existing[0].id)
    expect(findConflict(existing, at('11:00', '12:00'))).toBeUndefined()
    expect(findConflict(existing, at('09:00', '10:00'))).toBeUndefined()
    expect(findConflict(existing, at('13:00', '13:30'))).toBeUndefined()
    expect(findConflict(existing, at('10:00', '11:00', 'chen'))).toBeUndefined()
    // A booking being moved does not clash with itself.
    expect(findConflict(existing, { ...at('10:15', '11:15'), id: existing[0].id })).toBeUndefined()
  })

  test('free starts step by a quarter hour inside opening hours', () => {
    const starts = freeStarts(existing, hours, 'lin', day, 60)
    expect(starts[0]).toBe(540)
    expect(starts).not.toContain(555) // 09:15–10:15 runs into 10:00
    expect(starts).toContain(660)
    expect(starts).toContain(780) // the cancelled 13:00 slot is free again
    expect(starts[starts.length - 1]).toBe(1020) // last hour before 18:00
    expect(freeStarts(existing, hours, 'lin', day, 60, existing[0].id)).toContain(570)
    expect(freeStarts(existing, hours, 'lin', '2026-11-08', 30)).toEqual([])
    expect(freeStarts([], hours, 'lin', '2026-11-07', 300)).toEqual([])
  })

  test('the day grid covers opening hours and anything booked outside them', () => {
    expect(dayRange({ opens: 570, closes: 1050 }, [])).toEqual({ opens: 540, closes: 1080 })
    expect(dayRange({ opens: 540, closes: 1080 }, [booking('lin', day, '07:30', '08:15'), booking('lin', day, '18:30', '20:10')])).toEqual({
      opens: 420,
      closes: 1260,
    })
    expect(dayRange(null, [])).toEqual({ opens: 540, closes: 1080 })
  })
})

describe('dashboard figures', () => {
  const week = weekDays(day)
  const data = {
    resources: [resource('lin'), resource('zhou'), resource('old', false)],
    opening_hours: hours,
    bookings: [
      booking('lin', day, '09:00', '10:30', 'completed', { price_cents: 38_000 }),
      booking('lin', '2026-11-03', '14:00', '15:00', 'no_show'),
      booking('lin', '2026-11-04', '09:00', '12:00', 'cancelled'),
      booking('zhou', '2026-11-05', '10:00', '11:00', 'completed', { price_cents: 28_000 }),
      booking('zhou', '2026-11-10', '10:00', '11:00', 'completed'),
    ],
  }

  test('utilization counts held slots against open minutes, active resources only', () => {
    const rows = utilization(data, week)
    expect(rows.map((r) => r.resource.id)).toEqual(['lin', 'zhou'])
    const open = 5 * 540 + 240
    expect(rows[0]).toMatchObject({ booked: 150, open })
    expect(rows[0].ratio).toBeCloseTo(150 / open)
    expect(rows[1].booked).toBe(60)
  })

  test('revenue from completed bookings at their booked price; no-show rate of due bookings', () => {
    expect(revenue(data.bookings, '2026-11-01', '2026-11-08')).toBe(66_000)
    expect(revenue(data.bookings, '2026-11-01', '2026-11-30')).toBe(96_000)
    expect(noShowRate(data.bookings, '2026-11-01', '2026-11-08')).toEqual({ rate: 1 / 3, missed: 1, due: 3 })
    expect(noShowRate(data.bookings, '2026-12-01', '2026-12-31')).toBeNull()
  })

  test('busy hours split a booking across the hours it spans', () => {
    const grid = busyHours(data.bookings, week)
    expect(grid[1][9]).toBe(60)
    expect(grid[1][10]).toBe(30)
    expect(grid[3][9]).toBe(0) // cancelled
    expect(grid[2][14]).toBe(60)
    expect(grid[4][10]).toBe(60)
    expect(grid.flat().reduce((a, b) => a + b, 0)).toBe(210)
  })

  test('customer history: visits, spend, no-shows, last and next visit', () => {
    const now = atLocal('2026-11-06', 720)
    const mine = [
      ...data.bookings,
      booking('lin', '2026-11-09', '09:00', '10:00', 'confirmed'),
      booking('lin', '2026-11-20', '09:00', '10:00', 'confirmed'),
      booking('lin', '2026-11-04', '09:00', '10:00', 'completed', { customer_id: 'someone-else' }),
    ]
    const summary = customerSummary(mine, 'c1', now)
    expect(summary.visits).toBe(3)
    expect(summary.spent).toBe(38_000 + 28_000 + 30_000)
    expect(summary.noShows).toBe(1)
    expect(summary.lastVisit?.starts_at).toBe(atLocal('2026-11-10', 600))
    expect(summary.nextVisit?.starts_at).toBe(atLocal('2026-11-09', 540))
    expect(summary.history).toHaveLength(7)
    expect(summary.history[0].starts_at >= summary.history[1].starts_at).toBe(true)
  })

  test('a confirmed booking that has ended is waiting to be checked out', () => {
    const b = booking('lin', day, '09:00', '10:00')
    expect(awaitingCheckout(b, atLocal(day, 600))).toBe(true)
    expect(awaitingCheckout(b, atLocal(day, 599))).toBe(false)
    expect(awaitingCheckout({ ...b, status: 'completed' }, atLocal(day, 700))).toBe(false)
  })

  test('the read-only demo opens on the day it was seeded; a copy opens on today', () => {
    const seeded = { bookings: [booking('lin', '2026-10-05', '09:00', '10:00'), booking('lin', '2026-10-20', '09:00', '10:00')] }
    expect(anchorDay({ ...seeded, readOnly: true }, '2027-03-01')).toBe('2026-11-02')
    expect(anchorDay({ ...seeded, readOnly: false }, '2027-03-01')).toBe('2027-03-01')
    expect(anchorDay({ bookings: [], readOnly: true }, '2027-03-01')).toBe('2027-03-01')
  })
})

describe('writes', () => {
  const book = { type: 'book' as const, id: uuid(1), resourceId: uuid(2), serviceId: uuid(3), customerId: uuid(4), startsAt: atLocal(day, 600), notes: '' }

  test('every action is one statement on one table; bookings leave ends_at to the trigger', () => {
    const insert = statementFor(book)
    expect(insert.sql).toStartWith('INSERT INTO bookings')
    expect(insert.sql).not.toContain('ends_at')
    expect(insert.sql).toContain('ON CONFLICT (id) DO NOTHING')
    expect(insert.params).toEqual([uuid(1), uuid(2), uuid(3), uuid(4), book.startsAt, ''])
    const actions = [
      book,
      { type: 'edit-booking' as const, id: uuid(1), resourceId: uuid(2), serviceId: uuid(3), startsAt: book.startsAt, notes: 'x' },
      { type: 'set-status' as const, id: uuid(1), status: 'completed' as const },
      { type: 'save-customer' as const, id: uuid(5), name: ' Ada ', phone: '', email: '', notes: '' },
      { type: 'save-service' as const, id: uuid(6), name: '按摩', name_en: 'Massage', durationMin: 60, priceCents: 30_000, active: true },
      { type: 'save-resource' as const, id: uuid(7), name: '林', name_en: 'Lin', kind: 'staff' as const, color: '#AABBCC', active: true },
      { type: 'set-hours' as const, weekday: 0, opens: '10:00', closes: '16:00' },
      { type: 'close-day' as const, weekday: 0 },
    ]
    for (const action of actions) {
      const { sql } = statementFor(action)
      expect(sql).toMatch(/^(INSERT|UPDATE|DELETE) /)
      expect(sql).not.toContain(';')
    }
    expect(statementFor(actions[3]).params[1]).toBe('Ada')
    expect(statementFor(actions[5]).params[4]).toBe('#aabbcc')
  })

  test('nonsense is caught before it is sent', () => {
    expect(problemWith({ ...book, customerId: '' })).toBe('customer_required')
    expect(problemWith({ ...book, startsAt: 'soon' })).toBe('invalid_time')
    expect(problemWith({ type: 'save-customer', id: uuid(1), name: '  ', phone: '', email: '', notes: '' })).toBe('name_required')
    const service = { type: 'save-service' as const, id: uuid(1), name: 'x', name_en: '', durationMin: 45, priceCents: 100, active: true }
    expect(problemWith(service)).toBeNull()
    expect(problemWith({ ...service, durationMin: 47 })).toBe('invalid_duration')
    expect(problemWith({ ...service, durationMin: 600 })).toBe('invalid_duration')
    expect(problemWith({ ...service, priceCents: -1 })).toBe('invalid_price')
    expect(problemWith({ ...service, priceCents: 1.5 })).toBe('invalid_price')
    expect(problemWith({ type: 'set-hours', weekday: 1, opens: '18:00', closes: '09:00' })).toBe('invalid_hours')
    expect(problemWith({ type: 'set-hours', weekday: 7, opens: '09:00', closes: '18:00' })).toBe('invalid_input')
    expect(problemWith({ type: 'save-resource', id: uuid(1), name: 'x', name_en: '', kind: 'staff', color: 'teal', active: true })).toBe('invalid_input')
    expect(() => statementFor({ ...book, id: 'nope' })).toThrow('invalid_input')
  })

  test('reads are single SELECTs that cast numerics to numbers', () => {
    for (const sql of Object.values(readStatements)) {
      expect(sql).toStartWith('SELECT ')
      expect(sql).not.toContain(';')
    }
    expect(readStatements.services).toContain('duration_min::float8')
    expect(readStatements.bookings).toContain('price_cents::float8')
  })

  test('database errors map to friendly keys', () => {
    expect(errorKey('booking_overlap')).toBe('booking_overlap')
    expect(errorKey('ERROR: booking_overlap (at position 3)')).toBe('booking_overlap')
    expect(errorKey('permission denied for table bookings')).toBe('read_only')
    expect(errorKey('new row for relation "services" violates check constraint "services_check"')).toBe('invalid_input')
    expect(errorKey('insert or update on table "bookings" violates foreign key constraint')).toBe('record_unavailable')
    expect(errorKey('HTTP 502')).toBe('generic_error')
    expect(errorKey('read_only')).toBe('read_only')
  })

  test('prices parse to whole cents', () => {
    expect(parsePrice('380')).toBe(38_000)
    expect(parsePrice('¥1,280.5')).toBe(128_050)
    expect(parsePrice('1.234')).toBeNull()
    expect(parsePrice('-3')).toBeNull()
  })
})
