export type Locale = 'zh' | 'en'
export type AccountKind = 'asset' | 'liability' | 'income' | 'expense' | 'equity'
export type Currency = 'USD' | 'EUR' | 'GBP'
export type EntryKind = 'expense' | 'income' | 'transfer' | 'opening' | 'reversal'
export const accountKinds: AccountKind[] = ['asset', 'liability', 'income', 'expense', 'equity']
export const currencies: Currency[] = ['USD', 'EUR', 'GBP']
/** Reports, budgets and every entry balance in this currency. */
export const BASE_CURRENCY: Currency = 'USD'
export const ledgerTables = ['accounts', 'fx_rates', 'entries', 'postings', 'budgets'] as const
export const MAX_AMOUNT_CENTS = 10_000_000_000
export const MAX_RATE = 10_000

type RecordBase = { id: string; created_at: string }
export type Account = RecordBase & {
  name: string
  name_en: string
  kind: AccountKind
  currency: Currency
  archived: boolean
}
/** How many base-currency units one unit of `currency` is worth. */
export type FxRate = RecordBase & { currency: Currency; rate: number }
export type Entry = RecordBase & {
  occurred_on: string
  kind: EntryKind
  payee: string
  memo: string
  reverses: string | null
}
/**
 * One line of an entry. Debits are positive: an asset or expense grows, a liability, income or
 * equity account shrinks. `amount_cents` is in the account's currency, `base_cents` in the base
 * currency at the rate the entry was recorded with. The base amounts of an entry sum to zero.
 */
export type Posting = RecordBase & {
  entry_id: string
  account_id: string
  amount_cents: number
  base_cents: number
}
export type Budget = RecordBase & { account_id: string; month: string; amount_cents: number }
export type LedgerData = {
  readOnly: boolean
  accounts: Account[]
  fx_rates: FxRate[]
  entries: Entry[]
  postings: Posting[]
  budgets: Budget[]
}

export type RecordInput = {
  kind: 'expense' | 'income' | 'transfer'
  occurredOn: string
  payee: string
  memo: string
  fromAccountId: string
  toAccountId: string
  amountCents: number
  /** Transfers between currencies only: what arrived, in the destination account's currency. */
  toAmountCents?: number
}
export type AccountInput = {
  name: string
  name_en: string
  kind: AccountKind
  currency: Currency
  archived: boolean
}
export type LedgerCommand = { requestId: string } & (
  | ({ action: 'record' } & RecordInput)
  | { action: 'reverse'; entryId: string; occurredOn: string }
  | ({ action: 'save-account'; id?: string; openingCents?: number; openedOn?: string } & AccountInput)
  | { action: 'set-budget'; accountId: string; month: string; amountCents: number }
  | { action: 'set-rate'; currency: Currency; rate: number }
)
export type LedgerResult = { id: string }
export type LedgerClient = {
  read(): Promise<LedgerData>
  command(command: LedgerCommand): Promise<LedgerResult>
}
export type PlannedPosting = { account_id: string; amount_cents: number; base_cents: number }

const isAmount = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= MAX_AMOUNT_CENTS
export const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().startsWith(value)
export const isMonth = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value)

export function rateOf(rates: Pick<FxRate, 'currency' | 'rate'>[], currency: Currency) {
  if (currency === BASE_CURRENCY) return 1
  const rate = rates.find((r) => r.currency === currency)?.rate
  if (!rate || !(rate > 0) || rate > MAX_RATE) throw new Error('rate_unavailable')
  return rate
}
export const toBase = (cents: number, rate: number) => Math.round(cents * rate)

/** Money accounts are the ones an entry draws from or pays into; categories are what it was for. */
export const isMoney = (a: Pick<Account, 'kind'>) => a.kind === 'asset' || a.kind === 'liability'

/**
 * Turns what a person typed into balanced postings. Also used on the server, which never trusts
 * a submitted base amount: it re-plans from the stored accounts and rates.
 */
export function planEntry(
  input: RecordInput,
  accounts: Account[],
  rates: Pick<FxRate, 'currency' | 'rate'>[],
): PlannedPosting[] {
  if (!isDay(input.occurredOn)) throw new Error('invalid_date')
  if (!isAmount(input.amountCents)) throw new Error('invalid_amount')
  if (input.fromAccountId === input.toAccountId) throw new Error('same_account')
  const from = accounts.find((a) => a.id === input.fromAccountId)
  const to = accounts.find((a) => a.id === input.toAccountId)
  if (!from || !to || from.archived || to.archived) throw new Error('account_unavailable')
  const expected: Record<RecordInput['kind'], [AccountKind[], AccountKind[]]> = {
    expense: [['asset', 'liability'], ['expense']],
    income: [['income'], ['asset', 'liability']],
    transfer: [['asset', 'liability'], ['asset', 'liability']],
  }
  const [fromKinds, toKinds] = expected[input.kind]
  if (!fromKinds.includes(from.kind) || !toKinds.includes(to.kind)) throw new Error('invalid_accounts')
  // The amount is typed in the money account's currency. Categories are kept in the base
  // currency, so spending from a EUR account books its converted value against the category.
  let left = input.amountCents
  let arrived = input.amountCents
  if (input.kind === 'transfer') {
    if (from.currency !== to.currency) {
      if (!isAmount(input.toAmountCents)) throw new Error('invalid_amount')
      arrived = input.toAmountCents
    } else if (input.toAmountCents !== undefined && input.toAmountCents !== left)
      throw new Error('invalid_amount')
  } else {
    if (input.toAmountCents !== undefined) throw new Error('invalid_amount')
    const holder = input.kind === 'expense' ? from : to
    const converted = toBase(input.amountCents, rateOf(rates, holder.currency))
    if (input.kind === 'expense') arrived = converted
    else left = converted
  }
  // A base-currency leg is exact; otherwise the destination's value at today's rate decides it.
  const base =
    from.currency === BASE_CURRENCY
      ? left
      : to.currency === BASE_CURRENCY
        ? arrived
        : toBase(arrived, rateOf(rates, to.currency))
  if (!isAmount(base) || !isAmount(arrived) || !isAmount(left)) throw new Error('invalid_amount')
  return [
    { account_id: from.id, amount_cents: -left, base_cents: -base },
    { account_id: to.id, amount_cents: arrived, base_cents: base },
  ]
}

/** An opening balance is booked against the equity account, so it never shows up as income. */
export function planOpening(
  account: Account,
  equity: Account,
  cents: number,
  rates: Pick<FxRate, 'currency' | 'rate'>[],
): PlannedPosting[] {
  if (!isMoney(account)) throw new Error('invalid_accounts')
  if (!Number.isSafeInteger(cents) || cents === 0 || Math.abs(cents) > MAX_AMOUNT_CENTS)
    throw new Error('invalid_amount')
  const base = toBase(cents, rateOf(rates, account.currency))
  if (base === 0) throw new Error('invalid_amount')
  return [
    { account_id: account.id, amount_cents: cents, base_cents: base },
    { account_id: equity.id, amount_cents: -base, base_cents: -base },
  ]
}

export const reversePostings = (postings: Pick<Posting, 'account_id' | 'amount_cents' | 'base_cents'>[]) =>
  postings.map((p) => ({ account_id: p.account_id, amount_cents: -p.amount_cents, base_cents: -p.base_cents }))

export const isBalanced = (postings: Pick<Posting, 'base_cents'>[]) =>
  postings.length >= 2 && postings.reduce((sum, p) => sum + p.base_cents, 0) === 0

/** Credit-normal accounts read the other way round: a card owing $500 shows 500, not -500. */
export const sign = (kind: AccountKind) => (kind === 'asset' || kind === 'expense' ? 1 : -1)

export type Balance = { native: number; base: number }
/** Native balances, valued in the base currency at today's rates. */
export function balances(data: Pick<LedgerData, 'accounts' | 'postings' | 'fx_rates'>) {
  const totals = new Map<string, number>()
  for (const p of data.postings) totals.set(p.account_id, (totals.get(p.account_id) ?? 0) + p.amount_cents)
  return new Map<string, Balance>(
    data.accounts.map((a) => {
      const native = totals.get(a.id) ?? 0
      let base = native
      try {
        base = toBase(native, rateOf(data.fx_rates, a.currency))
      } catch {}
      return [a.id, { native, base }]
    }),
  )
}

export const monthOf = (day: string) => day.slice(0, 7)
export function lastMonths(end: string, count: number) {
  const [y, m] = end.split('-').map(Number)
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1))
    return d.toISOString().slice(0, 7)
  })
}

/**
 * Income and spending per month in the base currency, from postings to income and expense
 * accounts. A reversal lands in the month it was recorded, the way a bank statement shows it.
 */
export function cashFlow(data: Pick<LedgerData, 'accounts' | 'entries' | 'postings'>, months: string[]) {
  const kinds = new Map(data.accounts.map((a) => [a.id, a.kind]))
  const day = new Map(data.entries.map((e) => [e.id, e.occurred_on]))
  const rows = new Map(months.map((m) => [m, { month: m, income: 0, expense: 0 }]))
  for (const p of data.postings) {
    const row = rows.get(monthOf(day.get(p.entry_id) ?? ''))
    const kind = kinds.get(p.account_id)
    if (!row) continue
    if (kind === 'income') row.income -= p.base_cents
    else if (kind === 'expense') row.expense += p.base_cents
  }
  return [...rows.values()]
}

export function spendingByCategory(data: Pick<LedgerData, 'accounts' | 'entries' | 'postings'>, month: string) {
  const day = new Map(data.entries.map((e) => [e.id, e.occurred_on]))
  const totals = new Map<string, number>()
  for (const p of data.postings)
    if (monthOf(day.get(p.entry_id) ?? '') === month)
      totals.set(p.account_id, (totals.get(p.account_id) ?? 0) + p.base_cents)
  return data.accounts
    .filter((a) => a.kind === 'expense' && (totals.get(a.id) ?? 0) !== 0)
    .map((account) => ({ account, cents: totals.get(account.id)! }))
    .sort((a, b) => b.cents - a.cents)
}

export type BudgetLine = { account: Account; budget: number; spent: number }
export function budgetProgress(data: Pick<LedgerData, 'accounts' | 'entries' | 'postings' | 'budgets'>, month: string) {
  const spent = new Map(spendingByCategory(data, month).map((s) => [s.account.id, s.cents]))
  const planned = new Map(data.budgets.filter((b) => b.month === month).map((b) => [b.account_id, b.amount_cents]))
  return data.accounts
    .filter((a) => a.kind === 'expense' && (planned.has(a.id) || spent.has(a.id)))
    .map((account): BudgetLine => ({
      account,
      budget: planned.get(account.id) ?? 0,
      spent: spent.get(account.id) ?? 0,
    }))
    .sort((a, b) => b.budget - a.budget || b.spent - a.spent)
}

/**
 * Net worth at the end of each month, at the rates each entry was recorded with. Today's figure
 * on the overview uses today's rates instead, so the two can differ by the currency movement.
 */
export function netWorthSeries(data: Pick<LedgerData, 'accounts' | 'entries' | 'postings'>, months: string[]) {
  const holders = new Set(data.accounts.filter(isMoney).map((a) => a.id))
  const day = new Map(data.entries.map((e) => [e.id, e.occurred_on]))
  const byMonth = new Map<string, number>()
  let before = 0
  for (const p of data.postings) {
    if (!holders.has(p.account_id)) continue
    const month = monthOf(day.get(p.entry_id) ?? '')
    if (month < months[0]) before += p.base_cents
    else byMonth.set(month, (byMonth.get(month) ?? 0) + p.base_cents)
  }
  let running = before
  return months.map((month) => ({ month, cents: (running += byMonth.get(month) ?? 0) }))
}

/** `whole` drops the cents for at-a-glance figures; `compact` is for chart axes ($2万, $20K). */
export function money(cents: number, currency: Currency, locale: Locale, format: 'exact' | 'whole' | 'compact' = 'exact') {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    style: 'currency',
    currency,
    currencyDisplay: currency === BASE_CURRENCY ? 'narrowSymbol' : 'code',
    ...(format === 'compact'
      ? { notation: 'compact', maximumFractionDigits: 1 }
      : format === 'whole'
        ? { maximumFractionDigits: 0 }
        : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  }).format(cents / 100)
}

/** Parses "1,234.5" into 123450. Returns null for anything that is not a plain amount. */
export function parseAmount(text: string): number | null {
  const clean = text.replace(/[,\s，]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null
  const [whole, fraction = ''] = clean.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}

export const localized = (value: { name: string; name_en: string }, locale: Locale) =>
  locale === 'en' ? value.name_en || value.name : value.name

function csvCell(value: string | number) {
  let text = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = "'" + text
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** One row per posting. Text cells that a spreadsheet would run as a formula are neutralized. */
export function postingsCsv(data: LedgerData, locale: Locale) {
  const accounts = new Map(data.accounts.map((a) => [a.id, a]))
  const entries = new Map(data.entries.map((e) => [e.id, e]))
  const header = ['date', 'kind', 'payee', 'memo', 'account', 'currency', 'amount', `amount_${BASE_CURRENCY.toLowerCase()}`]
  const rows = data.postings
    .map((p) => ({ p, e: entries.get(p.entry_id), a: accounts.get(p.account_id) }))
    .filter((r) => r.e && r.a)
    .sort((x, y) => x.e!.occurred_on.localeCompare(y.e!.occurred_on) || x.e!.created_at.localeCompare(y.e!.created_at))
    .map(({ p, e, a }) => [
      e!.occurred_on, e!.kind, e!.payee, e!.memo, localized(a!, locale), a!.currency,
      (p.amount_cents / 100).toFixed(2), (p.base_cents / 100).toFixed(2),
    ])
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n'
}
