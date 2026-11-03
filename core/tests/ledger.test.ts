import { describe, expect, test } from 'bun:test'
import {
  balances,
  budgetProgress,
  cashFlow,
  isBalanced,
  lastMonths,
  netWorthSeries,
  parseAmount,
  planEntry,
  planOpening,
  postingsCsv,
  reversePostings,
  type Account,
  type AccountKind,
  type Currency,
  type LedgerData,
} from '../src/ledger'

const account = (id: string, kind: AccountKind, currency: Currency = 'USD'): Account => ({
  id,
  created_at: '',
  name: id,
  name_en: id,
  kind,
  currency,
  archived: false,
})
const accounts = [
  account('checking', 'asset'),
  account('eur', 'asset', 'EUR'),
  account('gbp', 'asset', 'GBP'),
  account('card', 'liability'),
  account('salary', 'income'),
  account('food', 'expense'),
  account('equity', 'equity'),
]
const rates = [
  { currency: 'EUR' as const, rate: 1.1 },
  { currency: 'GBP' as const, rate: 1.25 },
]
const input = { occurredOn: '2026-10-05', payee: '', memo: '' }

describe('planning entries', () => {
  test('expense moves money from an account into a category', () => {
    const legs = planEntry({ ...input, kind: 'expense', fromAccountId: 'checking', toAccountId: 'food', amountCents: 4_250 }, accounts, rates)
    expect(legs).toEqual([
      { account_id: 'checking', amount_cents: -4_250, base_cents: -4_250 },
      { account_id: 'food', amount_cents: 4_250, base_cents: 4_250 },
    ])
    expect(isBalanced(legs)).toBe(true)
  })
  test('spending from a foreign account books the converted value against the category', () => {
    const legs = planEntry({ ...input, kind: 'expense', fromAccountId: 'eur', toAccountId: 'food', amountCents: 10_000 }, accounts, rates)
    expect(legs[0]).toEqual({ account_id: 'eur', amount_cents: -10_000, base_cents: -11_000 })
    expect(legs[1]).toEqual({ account_id: 'food', amount_cents: 11_000, base_cents: 11_000 })
  })
  test('income into a foreign account', () => {
    const legs = planEntry({ ...input, kind: 'income', fromAccountId: 'salary', toAccountId: 'gbp', amountCents: 100_00 }, accounts, rates)
    expect(legs).toEqual([
      { account_id: 'salary', amount_cents: -12_500, base_cents: -12_500 },
      { account_id: 'gbp', amount_cents: 100_00, base_cents: 12_500 },
    ])
  })
  test('a cross-currency transfer uses what actually arrived', () => {
    const legs = planEntry(
      { ...input, kind: 'transfer', fromAccountId: 'checking', toAccountId: 'eur', amountCents: 300_000, toAmountCents: 276_000 },
      accounts,
      rates,
    )
    expect(legs).toEqual([
      { account_id: 'checking', amount_cents: -300_000, base_cents: -300_000 },
      { account_id: 'eur', amount_cents: 276_000, base_cents: 300_000 },
    ])
    const between = planEntry(
      { ...input, kind: 'transfer', fromAccountId: 'gbp', toAccountId: 'eur', amountCents: 10_000, toAmountCents: 11_400 },
      accounts,
      rates,
    )
    expect(between.map((l) => l.base_cents)).toEqual([-12_540, 12_540])
  })
  test('rejects what would not make sense in the books', () => {
    const plan = (over: object) => () =>
      planEntry({ ...input, kind: 'expense', fromAccountId: 'checking', toAccountId: 'food', amountCents: 100, ...over } as never, accounts, rates)
    expect(plan({ amountCents: 0 })).toThrow('invalid_amount')
    expect(plan({ amountCents: 1.5 })).toThrow('invalid_amount')
    expect(plan({ occurredOn: '2026-02-30' })).toThrow('invalid_date')
    expect(plan({ toAccountId: 'checking' })).toThrow('same_account')
    expect(plan({ toAccountId: 'salary' })).toThrow('invalid_accounts')
    expect(plan({ fromAccountId: 'equity' })).toThrow('invalid_accounts')
    expect(plan({ toAmountCents: 100 })).toThrow('invalid_amount')
    expect(plan({ kind: 'transfer', toAccountId: 'eur' })).toThrow('invalid_amount')
    expect(plan({ fromAccountId: 'missing' })).toThrow('account_unavailable')
    expect(() =>
      planEntry({ ...input, kind: 'expense', fromAccountId: 'eur', toAccountId: 'food', amountCents: 100 }, accounts, []),
    ).toThrow('rate_unavailable')
    const archived = accounts.map((a) => (a.id === 'food' ? { ...a, archived: true } : a))
    expect(() =>
      planEntry({ ...input, kind: 'expense', fromAccountId: 'checking', toAccountId: 'food', amountCents: 100 }, archived, rates),
    ).toThrow('account_unavailable')
  })
  test('opening balances and reversals stay balanced', () => {
    const opening = planOpening(accounts[1], accounts[6], 100_000, rates)
    expect(opening).toEqual([
      { account_id: 'eur', amount_cents: 100_000, base_cents: 110_000 },
      { account_id: 'equity', amount_cents: -110_000, base_cents: -110_000 },
    ])
    expect(isBalanced(reversePostings(opening))).toBe(true)
    expect(reversePostings(opening)[0].amount_cents).toBe(-100_000)
    expect(() => planOpening(accounts[5], accounts[6], 100, rates)).toThrow('invalid_accounts')
  })
})

describe('reports', () => {
  const posting = (id: string, entry: string, accountId: string, cents: number, base = cents) => ({
    id,
    created_at: '',
    entry_id: entry,
    account_id: accountId,
    amount_cents: cents,
    base_cents: base,
  })
  const entry = (id: string, day: string) => ({ id, created_at: day, occurred_on: day, kind: 'expense' as const, payee: '', memo: '', reverses: null })
  const data: LedgerData = {
    readOnly: false,
    accounts,
    fx_rates: rates.map((r, i) => ({ id: String(i), created_at: '', ...r })),
    entries: [entry('e1', '2026-09-30'), entry('e2', '2026-10-10'), entry('e3', '2026-10-12')],
    postings: [
      posting('p1', 'e1', 'eur', 100_000, 105_000),
      posting('p2', 'e1', 'equity', -105_000),
      posting('p3', 'e2', 'salary', -300_000),
      posting('p4', 'e2', 'checking', 300_000),
      posting('p5', 'e3', 'checking', -12_000),
      posting('p6', 'e3', 'food', 12_000),
    ],
    budgets: [{ id: 'b', created_at: '', account_id: 'food', month: '2026-10', amount_cents: 10_000 }],
  }
  test('balances value foreign money at today’s rate', () => {
    const b = balances(data)
    expect(b.get('eur')).toEqual({ native: 100_000, base: 110_000 })
    expect(b.get('checking')).toEqual({ native: 288_000, base: 288_000 })
  })
  test('cash flow, budgets and net worth by month', () => {
    const months = lastMonths('2026-10', 2)
    expect(months).toEqual(['2026-09', '2026-10'])
    expect(cashFlow(data, months)).toEqual([
      { month: '2026-09', income: 0, expense: 0 },
      { month: '2026-10', income: 300_000, expense: 12_000 },
    ])
    expect(budgetProgress(data, '2026-10').map((l) => [l.account.id, l.budget, l.spent])).toEqual([['food', 10_000, 12_000]])
    expect(netWorthSeries(data, months)).toEqual([
      { month: '2026-09', cents: 105_000 },
      { month: '2026-10', cents: 393_000 },
    ])
    expect(lastMonths('2026-01', 3)).toEqual(['2025-11', '2025-12', '2026-01'])
  })
  test('amount parsing and CSV export', () => {
    expect(parseAmount('1,234.5')).toBe(123_450)
    expect(parseAmount('0.07')).toBe(7)
    expect(parseAmount('-1')).toBeNull()
    expect(parseAmount('1.234')).toBeNull()
    const csv = postingsCsv({ ...data, entries: data.entries.map((e) => ({ ...e, payee: '=HYPERLINK("x")' })) }, 'en')
    expect(csv.split('\n')[0]).toBe('date,kind,payee,memo,account,currency,amount,amount_usd')
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
    expect(csv.trim().split('\n')).toHaveLength(7)
  })
})
