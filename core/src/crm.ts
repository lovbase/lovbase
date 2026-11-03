/**
 * Sales Pipeline CRM: the data contract, the pipeline arithmetic and every SQL statement the app
 * issues. A copy has no endpoint of its own: it reads and writes through the workspace SQL API,
 * one statement per call, and the database triggers keep stage history, close dates and
 * probabilities consistent. This file is copied into a remixed app as src/domain.ts, so it must
 * stay self-contained (no imports from the rest of core).
 */
export type Locale = 'zh' | 'en'
export type Stage = 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'
export type ActivityKind = 'call' | 'email' | 'meeting' | 'note' | 'task'
export const stages: Stage[] = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost']
export const openStages: Stage[] = ['lead', 'qualified', 'proposal', 'negotiation']
export const activityKinds: ActivityKind[] = ['call', 'email', 'meeting', 'note', 'task']
export const industries = [
  'software',
  'retail',
  'logistics',
  'food',
  'education',
  'healthcare',
  'manufacturing',
  'design',
  'travel',
  'finance',
] as const
export const lostReasons = ['price', 'competitor', 'timing', 'no_budget', 'no_decision'] as const
export const crmTables = ['companies', 'contacts', 'deals', 'activities', 'deal_stage_history'] as const
/** Every amount is integer cents in this currency. */
export const CURRENCY = 'CNY'
export const MAX_AMOUNT_CENTS = 1_000_000_000_000

/**
 * What an open deal in each stage is usually worth. Moving a deal into a stage resets its
 * probability to this unless the same update sets one; won and lost are always 100 and 0.
 * The database trigger uses the same table (see crm-model.ts).
 */
export const stageProbability: Record<Stage, number> = {
  lead: 10,
  qualified: 25,
  proposal: 50,
  negotiation: 75,
  won: 100,
  lost: 0,
}

type RecordBase = { id: string; created_at: string }
export type Company = RecordBase & { name: string; industry: string; website: string; city: string }
export type Contact = RecordBase & {
  company_id: string
  name: string
  title: string
  email: string
  phone: string
}
export type Deal = RecordBase & {
  company_id: string
  contact_id: string | null
  title: string
  stage: Stage
  amount_cents: number
  /** 0–100. */
  probability: number
  /** YYYY-MM-DD, or null when nobody has guessed yet. */
  expected_close: string | null
  owner: string
  /** YYYY-MM-DD. Set by the database when the deal is won or lost, cleared when it reopens. */
  closed_on: string | null
  lost_reason: string | null
}
export type Activity = RecordBase & {
  deal_id: string
  kind: ActivityKind
  body: string
  /** YYYY-MM-DD; only tasks have one. */
  due_on: string | null
  done: boolean
}
/** Written only by the database: one row when a deal is created and one per stage change. */
export type StageChange = RecordBase & {
  deal_id: string
  from_stage: Stage | null
  to_stage: Stage
  changed_at: string
}
export type CrmData = {
  readOnly: boolean
  companies: Company[]
  contacts: Contact[]
  deals: Deal[]
  activities: Activity[]
  deal_stage_history: StageChange[]
}

export type CompanyInput = { name: string; industry: string; website: string; city: string }
export type ContactInput = { companyId: string; name: string; title: string; email: string; phone: string }
export type DealInput = {
  companyId: string
  contactId: string | null
  title: string
  amountCents: number
  probability: number
  expectedClose: string | null
  owner: string
}
export type CrmAction =
  | ({ action: 'create-company' } & CompanyInput)
  | ({ action: 'update-company'; id: string } & CompanyInput)
  | ({ action: 'create-contact' } & ContactInput)
  | ({ action: 'update-contact'; id: string } & ContactInput)
  | ({ action: 'create-deal'; stage: Stage } & DealInput)
  | ({ action: 'update-deal'; id: string } & DealInput)
  /** `from` guards against moving a deal someone else already moved. */
  | { action: 'move-deal'; id: string; from: Stage; to: Stage; lostReason?: string | null }
  | { action: 'add-activity'; dealId: string; kind: ActivityKind; body: string; dueOn: string | null }
  | { action: 'set-activity-done'; id: string; done: boolean }
export type CrmClient = {
  read(): Promise<CrmData>
  run(action: CrmAction): Promise<void>
}
/** Structurally the shared DataTemplateProps, so the gallery can render this app too. */
export type CrmProps = {
  client: CrmClient
  initialData?: CrmData
  initialLocale?: Locale
  locale?: Locale
  onLocaleChange?: (locale: Locale) => void
}

export const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().startsWith(value)
export const isClosed = (stage: Stage) => stage === 'won' || stage === 'lost'
export const isStage = (value: unknown): value is Stage => stages.includes(value as Stage)
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

/** Returns an error key, or '' when the input may be written. The database re-checks all of it. */
export function validateDeal(input: DealInput) {
  if (!input.title.trim()) return 'title_required'
  if (!input.companyId) return 'company_required'
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0 || input.amountCents > MAX_AMOUNT_CENTS)
    return 'invalid_amount'
  if (!Number.isInteger(input.probability) || input.probability < 0 || input.probability > 100)
    return 'invalid_probability'
  if (input.expectedClose !== null && !isDay(input.expectedClose)) return 'invalid_date'
  return ''
}
export function validateCompany(input: CompanyInput) {
  if (!input.name.trim()) return 'name_required'
  return ''
}
export function validateContact(input: ContactInput) {
  if (!input.name.trim()) return 'name_required'
  if (!input.companyId) return 'company_required'
  if (input.email.trim() && !isEmail(input.email.trim())) return 'invalid_email'
  return ''
}

export const weighted = (deal: Pick<Deal, 'amount_cents' | 'probability'>) =>
  Math.round((deal.amount_cents * deal.probability) / 100)

export type StageTotal = { stage: Stage; count: number; amount: number; weighted: number }
export function pipelineByStage(deals: Deal[]): StageTotal[] {
  return stages.map((stage) => {
    const list = deals.filter((d) => d.stage === stage)
    return {
      stage,
      count: list.length,
      amount: list.reduce((sum, d) => sum + d.amount_cents, 0),
      weighted: list.reduce((sum, d) => sum + weighted(d), 0),
    }
  })
}

/** Open pipeline at face value and weighted by each deal's probability. */
export function forecast(deals: Deal[]) {
  const open = deals.filter((d) => !isClosed(d.stage))
  return {
    count: open.length,
    amount: open.reduce((sum, d) => sum + d.amount_cents, 0),
    weighted: open.reduce((sum, d) => sum + weighted(d), 0),
  }
}

/**
 * Won deals over every deal closed on or after `since` (YYYY-MM-DD; all time when omitted).
 * Null when nothing has closed yet, so the UI can say so instead of showing 0%.
 */
export function winRate(deals: Deal[], since?: string) {
  const closed = deals.filter((d) => isClosed(d.stage) && d.closed_on && (!since || d.closed_on >= since))
  if (!closed.length) return null
  return closed.filter((d) => d.stage === 'won').length / closed.length
}

export const monthOf = (day: string) => day.slice(0, 7)
export function lastMonths(end: string, count: number) {
  const [y, m] = end.split('-').map(Number)
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1)).toISOString().slice(0, 7))
}
export function addDays(day: string, days: number) {
  const d = new Date(day + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function wonByMonth(deals: Deal[], months: string[]) {
  const rows = new Map(months.map((month) => [month, { month, count: 0, amount: 0 }]))
  for (const d of deals) {
    const row = d.stage === 'won' && d.closed_on ? rows.get(monthOf(d.closed_on)) : undefined
    if (!row) continue
    row.count += 1
    row.amount += d.amount_cents
  }
  return [...rows.values()]
}

/** Open tasks due within `days` of today, overdue ones first. Tasks without a date sort last. */
export function upcomingTasks(activities: Activity[], today: string, days = 14) {
  const until = addDays(today, days)
  return activities
    .filter((a) => a.kind === 'task' && !a.done && (!a.due_on || a.due_on <= until))
    .sort((a, b) => (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999') || a.created_at.localeCompare(b.created_at))
}

/** Whole days since the deal last changed stage, from the history the database keeps. */
export function daysInStage(deal: Deal, history: StageChange[], now: Date) {
  let since = deal.created_at
  for (const h of history) if (h.deal_id === deal.id && h.to_stage === deal.stage && h.changed_at > since) since = h.changed_at
  return Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000))
}

/** One deal's history, oldest first. */
export const historyOf = (dealId: string, history: StageChange[]) =>
  history.filter((h) => h.deal_id === dealId).sort((a, b) => a.changed_at.localeCompare(b.changed_at))

/** The adjacent open stage, for the board's step buttons. Closed deals step back to negotiation. */
export function neighbourStage(stage: Stage, direction: -1 | 1): Stage | null {
  if (isClosed(stage)) return direction === -1 ? 'negotiation' : null
  const next = openStages.indexOf(stage) + direction
  if (next < 0) return null
  return next >= openStages.length ? 'won' : openStages[next]
}

/** Open deals by expected close (largest first on a tie, undated last), then closed ones, latest first. */
export function sortDeals(deals: Deal[]) {
  return [...deals].sort((a, b) => {
    const ca = isClosed(a.stage)
    const cb = isClosed(b.stage)
    if (ca !== cb) return ca ? 1 : -1
    if (ca) return (b.closed_on ?? '').localeCompare(a.closed_on ?? '')
    return (a.expected_close ?? '9999').localeCompare(b.expected_close ?? '9999') || b.amount_cents - a.amount_cents
  })
}

export function matchesDeal(deal: Deal, company: Company | undefined, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${deal.title} ${deal.owner} ${company?.name ?? ''}`.toLowerCase().includes(q)
}

/** `whole` drops the cents for at-a-glance figures; `compact` is for chart axes (¥2万, ¥20K). */
export function money(cents: number, locale: Locale, format: 'exact' | 'whole' | 'compact' = 'whole') {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    style: 'currency',
    currency: CURRENCY,
    currencyDisplay: 'narrowSymbol',
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

// ── SQL ──
// Every statement is one INSERT, UPDATE or SELECT against one table, the only shape the SQL API
// runs. Numerics are cast to float8 so they arrive as JSON numbers; timestamps serialize as ISO.
// The statements may not contain a semicolon, even inside a string.

export type Statement = { sql: string; params: unknown[] }

const columns: Record<(typeof crmTables)[number], string> = {
  companies: 'id, created_at, name, industry, website, city',
  contacts: 'id, created_at, company_id, name, title, email, phone',
  deals:
    'id, created_at, company_id, contact_id, title, stage, amount_cents::float8 AS amount_cents, probability::float8 AS probability, expected_close, owner, closed_on, lost_reason',
  activities: 'id, created_at, deal_id, kind, body, due_on, done',
  deal_stage_history: 'id, created_at, deal_id, from_stage, to_stage, changed_at',
}
/** One read per table, in the order TemplatesService.readTables uses. Capped at 1000 rows each. */
export const crmReads = crmTables.map((table) => ({
  table,
  sql: `SELECT ${columns[table]} FROM ${table} ORDER BY created_at, id`,
}))

const text = (value: string) => value.trim()
const optional = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null)

/**
 * The single statement for an action. Writes return the touched id, so the client can tell a
 * row that no longer matches (deleted, or moved by someone else) from a success.
 */
export function crmStatement(action: CrmAction): Statement {
  switch (action.action) {
    case 'create-company':
    case 'update-company': {
      const values = [text(action.name), action.industry, text(action.website), text(action.city)]
      return action.action === 'create-company'
        ? { sql: 'INSERT INTO companies (name, industry, website, city) VALUES ($1, $2, $3, $4) RETURNING id', params: values }
        : { sql: 'UPDATE companies SET name = $2, industry = $3, website = $4, city = $5 WHERE id = $1 RETURNING id', params: [action.id, ...values] }
    }
    case 'create-contact':
    case 'update-contact': {
      const values = [action.companyId, text(action.name), text(action.title), text(action.email), text(action.phone)]
      return action.action === 'create-contact'
        ? { sql: 'INSERT INTO contacts (company_id, name, title, email, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id', params: values }
        : { sql: 'UPDATE contacts SET company_id = $2, name = $3, title = $4, email = $5, phone = $6 WHERE id = $1 RETURNING id', params: [action.id, ...values] }
    }
    case 'create-deal':
      return {
        sql: 'INSERT INTO deals (company_id, contact_id, title, stage, amount_cents, probability, expected_close, owner) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
        params: [action.companyId, action.contactId, text(action.title), action.stage, action.amountCents, action.probability, action.expectedClose, text(action.owner)],
      }
    case 'update-deal':
      return {
        sql: 'UPDATE deals SET company_id = $2, contact_id = $3, title = $4, amount_cents = $5, probability = $6, expected_close = $7, owner = $8 WHERE id = $1 RETURNING id',
        params: [action.id, action.companyId, action.contactId, text(action.title), action.amountCents, action.probability, action.expectedClose, text(action.owner)],
      }
    case 'move-deal':
      // Probability, close date and the history row are the trigger's job, not the client's.
      return {
        sql: 'UPDATE deals SET stage = $3, lost_reason = $4 WHERE id = $1 AND stage = $2 RETURNING id',
        params: [action.id, action.from, action.to, action.to === 'lost' ? optional(action.lostReason) : null],
      }
    case 'add-activity':
      return {
        sql: 'INSERT INTO activities (deal_id, kind, body, due_on, done) VALUES ($1, $2, $3, $4, false) RETURNING id',
        params: [action.dealId, action.kind, text(action.body), action.kind === 'task' ? action.dueOn : null],
      }
    case 'set-activity-done':
      return { sql: "UPDATE activities SET done = $2 WHERE id = $1 AND kind = 'task' RETURNING id", params: [action.id, action.done] }
  }
}
