import { describe, expect, test } from 'bun:test'
import {
  crmReads,
  crmStatement,
  crmTables,
  daysInStage,
  forecast,
  historyOf,
  lastMonths,
  matchesDeal,
  money,
  neighbourStage,
  parseAmount,
  pipelineByStage,
  sortDeals,
  upcomingTasks,
  validateContact,
  validateDeal,
  weighted,
  winRate,
  wonByMonth,
  type Activity,
  type Deal,
  type DealInput,
  type Stage,
  type StageChange,
} from '../src/crm'

let n = 0
const deal = (stage: Stage, amount: number, probability: number, extra: Partial<Deal> = {}): Deal => ({
  id: `d${++n}`,
  created_at: '2026-06-01T09:00:00.000Z',
  company_id: 'c1',
  contact_id: null,
  title: `Deal ${n}`,
  stage,
  amount_cents: amount,
  probability,
  expected_close: null,
  owner: 'Alex',
  closed_on: null,
  lost_reason: null,
  ...extra,
})
const task = (id: string, due: string | null, done = false, kind: Activity['kind'] = 'task'): Activity => ({
  id,
  created_at: `2026-10-0${id.length}T00:00:00.000Z`,
  deal_id: 'd1',
  kind,
  body: id,
  due_on: due,
  done,
})

describe('pipeline arithmetic', () => {
  const deals = [
    deal('lead', 100_000, 10),
    deal('proposal', 300_000, 50),
    deal('proposal', 200_000, 55),
    deal('won', 500_000, 100, { closed_on: '2026-10-03' }),
    deal('lost', 900_000, 0, { closed_on: '2026-09-20' }),
  ]
  test('weighted value rounds to whole cents', () => {
    expect(weighted({ amount_cents: 333, probability: 50 })).toBe(167)
    expect(weighted({ amount_cents: 200_000, probability: 55 })).toBe(110_000)
  })
  test('totals per stage keep every stage in board order', () => {
    const totals = pipelineByStage(deals)
    expect(totals.map((s) => s.stage)).toEqual(['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'])
    expect(totals.find((s) => s.stage === 'proposal')).toEqual({ stage: 'proposal', count: 2, amount: 500_000, weighted: 260_000 })
    expect(totals.find((s) => s.stage === 'qualified')).toEqual({ stage: 'qualified', count: 0, amount: 0, weighted: 0 })
  })
  test('forecast counts open deals only', () => {
    expect(forecast(deals)).toEqual({ count: 3, amount: 600_000, weighted: 270_000 })
    expect(forecast([])).toEqual({ count: 0, amount: 0, weighted: 0 })
  })
  test('win rate is won over closed, within the window, and null with nothing closed', () => {
    expect(winRate(deals)).toBe(0.5)
    expect(winRate(deals, '2026-10-01')).toBe(1)
    expect(winRate(deals, '2026-11-01')).toBeNull()
    expect(winRate([deal('lead', 1, 10)])).toBeNull()
  })
  test('won per month buckets by close date and ignores months outside the range', () => {
    const months = lastMonths('2026-10', 3)
    expect(months).toEqual(['2026-08', '2026-09', '2026-10'])
    const rows = wonByMonth([...deals, deal('won', 50_000, 100, { closed_on: '2026-10-28' }), deal('won', 7, 100, { closed_on: '2026-02-01' })], months)
    expect(rows).toEqual([
      { month: '2026-08', count: 0, amount: 0 },
      { month: '2026-09', count: 0, amount: 0 },
      { month: '2026-10', count: 2, amount: 550_000 },
    ])
    expect(lastMonths('2026-01', 2)).toEqual(['2025-12', '2026-01'])
  })
})

describe('stage rules', () => {
  test('step buttons walk the open stages, then won; closed deals step back to negotiation', () => {
    expect(neighbourStage('lead', -1)).toBeNull()
    expect(neighbourStage('lead', 1)).toBe('qualified')
    expect(neighbourStage('negotiation', 1)).toBe('won')
    expect(neighbourStage('won', 1)).toBeNull()
    expect(neighbourStage('lost', -1)).toBe('negotiation')
  })
  test('days in stage counts from the latest move into the current stage', () => {
    const d = deal('proposal', 1, 50, { id: 'x', created_at: '2026-09-01T00:00:00.000Z' })
    const history: StageChange[] = [
      { id: 'h1', created_at: '', deal_id: 'x', from_stage: null, to_stage: 'lead', changed_at: '2026-09-01T00:00:00.000Z' },
      { id: 'h3', created_at: '', deal_id: 'x', from_stage: 'qualified', to_stage: 'proposal', changed_at: '2026-09-20T00:00:00.000Z' },
      { id: 'h2', created_at: '', deal_id: 'x', from_stage: 'lead', to_stage: 'qualified', changed_at: '2026-09-10T00:00:00.000Z' },
      { id: 'other', created_at: '', deal_id: 'y', from_stage: 'lead', to_stage: 'proposal', changed_at: '2026-09-29T00:00:00.000Z' },
    ]
    expect(daysInStage(d, history, new Date('2026-09-30T12:00:00.000Z'))).toBe(10)
    expect(daysInStage({ ...d, stage: 'won' }, history, new Date('2026-09-30T00:00:00.000Z'))).toBe(29)
    expect(historyOf('x', history).map((h) => h.id)).toEqual(['h1', 'h2', 'h3'])
  })
  test('deal validation mirrors the database checks', () => {
    const ok: DealInput = { companyId: 'c', contactId: null, title: 'Pilot', amountCents: 0, probability: 40, expectedClose: '2026-12-31', owner: '' }
    expect(validateDeal(ok)).toBe('')
    expect(validateDeal({ ...ok, title: '  ' })).toBe('title_required')
    expect(validateDeal({ ...ok, companyId: '' })).toBe('company_required')
    expect(validateDeal({ ...ok, amountCents: -1 })).toBe('invalid_amount')
    expect(validateDeal({ ...ok, amountCents: 1.5 })).toBe('invalid_amount')
    expect(validateDeal({ ...ok, probability: 101 })).toBe('invalid_probability')
    expect(validateDeal({ ...ok, probability: 33.3 })).toBe('invalid_probability')
    expect(validateDeal({ ...ok, expectedClose: '2026-02-30' })).toBe('invalid_date')
    expect(validateDeal({ ...ok, expectedClose: null })).toBe('')
    expect(validateContact({ companyId: 'c', name: 'Ann', title: '', email: 'ann@', phone: '' })).toBe('invalid_email')
    expect(validateContact({ companyId: 'c', name: 'Ann', title: '', email: '', phone: '' })).toBe('')
  })
})

describe('lists', () => {
  test('upcoming tasks: open tasks in the window, overdue first, undated last', () => {
    const list = upcomingTasks(
      [task('late', '2026-10-01'), task('soon', '2026-10-09'), task('far', '2026-12-01'), task('nodate', null), task('done', '2026-10-05', true), task('call', null, false, 'call')],
      '2026-10-05',
      14,
    )
    expect(list.map((a) => a.id)).toEqual(['late', 'soon', 'nodate'])
  })
  test('deals sort open-by-close-date, then closed newest first', () => {
    const list = sortDeals([
      deal('won', 1, 100, { id: 'w-old', closed_on: '2026-08-01' }),
      deal('lead', 1, 10, { id: 'undated' }),
      deal('proposal', 5, 50, { id: 'big', expected_close: '2026-11-01' }),
      deal('proposal', 1, 50, { id: 'small', expected_close: '2026-11-01' }),
      deal('lost', 1, 0, { id: 'l-new', closed_on: '2026-10-01' }),
    ])
    expect(list.map((d) => d.id)).toEqual(['big', 'small', 'undated', 'l-new', 'w-old'])
  })
  test('search matches title, owner and company, case-insensitively', () => {
    const d = deal('lead', 1, 10, { title: 'Fleet rollout', owner: '李悦' })
    const company = { id: 'c1', created_at: '', name: 'Northgate', industry: '', website: '', city: '' }
    expect(matchesDeal(d, company, 'fleet')).toBe(true)
    expect(matchesDeal(d, company, 'NORTH')).toBe(true)
    expect(matchesDeal(d, company, '李')).toBe(true)
    expect(matchesDeal(d, company, 'harbour')).toBe(false)
    expect(matchesDeal(d, undefined, ' ')).toBe(true)
  })
  test('amounts parse to cents and format per locale', () => {
    expect(parseAmount('1,234.5')).toBe(123_450)
    expect(parseAmount('12.345')).toBeNull()
    expect(parseAmount('-3')).toBeNull()
    expect(money(123_456_78, 'en')).toBe('¥123,457')
    expect(money(150_000_00, 'zh', 'compact')).toMatch(/^¥15(\.0)?万$/)
  })
})

describe('SQL statements', () => {
  test('one read per table, numerics cast so they arrive as numbers', () => {
    expect(crmReads.map((r) => r.table)).toEqual([...crmTables])
    expect(crmReads.find((r) => r.table === 'deals')!.sql).toContain('amount_cents::float8 AS amount_cents')
  })
  test('every write is a single INSERT or UPDATE that returns its id, with no semicolons', () => {
    const statements = [
      crmStatement({ action: 'create-company', name: ' Acme ', industry: 'retail', website: '', city: '' }),
      crmStatement({ action: 'update-contact', id: 'p', companyId: 'c', name: 'A', title: '', email: '', phone: '' }),
      crmStatement({ action: 'create-deal', stage: 'lead', companyId: 'c', contactId: null, title: 'X', amountCents: 1, probability: 10, expectedClose: null, owner: '' }),
      crmStatement({ action: 'move-deal', id: 'd', from: 'proposal', to: 'won', lostReason: 'price' }),
      crmStatement({ action: 'add-activity', dealId: 'd', kind: 'note', body: 'hi', dueOn: '2026-10-01' }),
      crmStatement({ action: 'set-activity-done', id: 'a', done: true }),
    ]
    for (const s of statements) {
      expect(s.sql).toMatch(/^(INSERT|UPDATE) /)
      expect(s.sql).toEndWith('RETURNING id')
      expect(s.sql).not.toContain(';')
    }
    expect(statements[0].params[0]).toBe('Acme')
    // A lost reason only travels with a move to lost; a note never carries a due date.
    expect(statements[3].params).toEqual(['d', 'proposal', 'won', null])
    expect(crmStatement({ action: 'move-deal', id: 'd', from: 'proposal', to: 'lost', lostReason: ' price ' }).params[3]).toBe('price')
    expect(statements[4].params[3]).toBeNull()
  })
})
