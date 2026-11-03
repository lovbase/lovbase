export type Locale = 'zh' | 'en'
export type Plan = 'free' | 'pro' | 'enterprise'
export type Team = 'frontline' | 'technical' | 'billing'
export type Status = 'new' | 'open' | 'pending' | 'solved' | 'closed'
export type Priority = 'low' | 'normal' | 'high' | 'urgent'
export type Channel = 'email' | 'chat' | 'phone' | 'web'
/** A note is internal: written by an agent, never shown to the customer. */
export type AuthorKind = 'customer' | 'agent' | 'note'
export const plans: Plan[] = ['free', 'pro', 'enterprise']
export const teams: Team[] = ['frontline', 'technical', 'billing']
export const statuses: Status[] = ['new', 'open', 'pending', 'solved', 'closed']
/** Most pressing first, the order every list and chart uses. */
export const priorities: Priority[] = ['urgent', 'high', 'normal', 'low']
export const channels: Channel[] = ['email', 'chat', 'phone', 'web']
export const helpdeskTables = ['customers', 'agents', 'sla_policies', 'tickets', 'messages'] as const
/**
 * The SQL API returns at most 1000 rows per read, so the app reads a window: every customer and
 * agent up to that cap, the 1000 most recently active tickets and the 1000 newest messages. When a
 * read comes back full, the screens say so instead of silently treating it as the whole history.
 */
export const READ_WINDOW = 1000
export const MAX_BODY = 10_000
/** A running SLA clock turns amber when less than this share of its window is left. */
export const SOON_SHARE = 0.25

type RecordBase = { id: string; created_at: string }
export type Customer = RecordBase & { name: string; email: string; company: string; plan: Plan }
export type Agent = RecordBase & { name: string; email: string; team: Team; active: boolean }
export type SlaPolicy = RecordBase & { priority: Priority; first_response_minutes: number; resolution_minutes: number }
/**
 * `response_due_at` and `due_at` come from the SLA policy of the ticket's priority, measured from
 * `created_at`. `first_response_at`, `solved_at` and `last_activity_at` are stamped by database
 * triggers from the messages and status changes; the app only reads them.
 */
export type Ticket = RecordBase & {
  subject: string
  customer_id: string
  assignee_id: string | null
  status: Status
  priority: Priority
  channel: Channel
  /** Comma-separated, lower case. */
  tags: string
  response_due_at: string | null
  due_at: string | null
  first_response_at: string | null
  solved_at: string | null
  last_activity_at: string
}
export type Message = RecordBase & { ticket_id: string; author_kind: AuthorKind; agent_id: string | null; body: string }
export type HelpdeskData = {
  readOnly: boolean
  customers: Customer[]
  agents: Agent[]
  sla_policies: SlaPolicy[]
  tickets: Ticket[]
  messages: Message[]
}

export type HelpdeskAction =
  | { type: 'reply'; ticketId: string; agentId: string; body: string; note: boolean }
  | { type: 'update-ticket'; ticketId: string; status?: Status; priority?: Priority; assigneeId?: string | null }
  | {
      type: 'create-ticket'
      /** Made by the client, so the opening message can name its ticket without a read in between. */
      id: string
      customerId: string
      subject: string
      body: string
      priority: Priority
      channel: Channel
      assigneeId: string | null
      tags: string
    }
  | { type: 'save-customer'; id?: string; name: string; email: string; company: string; plan: Plan }
  | { type: 'set-sla'; priority: Priority; firstResponseMinutes: number; resolutionMinutes: number }
/**
 * The same contract as DataTemplateClient in core/src/template-data.ts. It is spelled out here
 * because a copied app receives this file as src/domain.ts and has no @lovbase/core to import.
 */
export type HelpdeskClient = {
  read(): Promise<HelpdeskData>
  run(action: HelpdeskAction): Promise<void>
}

// ── Statements ──
// Both the copied app's client and the integration tests build their SQL here. Unqualified table
// names: the SQL API runs with search_path set to the project's schema. Each statement is one
// INSERT, UPDATE or SELECT on one table; the triggers installed with the template do the rest.

export type Statement = { sql: string; params: unknown[]; /** UPDATE … RETURNING: no row means it is gone. */ expectRow?: boolean }

export const readStatements: Record<(typeof helpdeskTables)[number], Statement> = {
  customers: { sql: `SELECT * FROM customers ORDER BY created_at, id LIMIT ${READ_WINDOW}`, params: [] },
  agents: { sql: `SELECT * FROM agents ORDER BY created_at, id LIMIT ${READ_WINDOW}`, params: [] },
  // numeric arrives as a string over the SQL API; float8 arrives as a number.
  sla_policies: {
    sql: `SELECT id, created_at, priority, first_response_minutes::float8 AS first_response_minutes,
      resolution_minutes::float8 AS resolution_minutes FROM sla_policies ORDER BY created_at, id`,
    params: [],
  },
  tickets: { sql: `SELECT * FROM tickets ORDER BY last_activity_at DESC, id LIMIT ${READ_WINDOW}`, params: [] },
  messages: { sql: `SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT ${READ_WINDOW}`, params: [] },
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isMinutes = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= 525_600
const text = (value: string, max: number, code: string) => {
  const clean = value.trim()
  if (!clean || clean.length > max) throw new Error(code)
  return clean
}
const id = (value: unknown) => {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('invalid_input')
  return value
}

/** Validates an action and turns it into the statements that carry it out, in order. */
export function actionStatements(action: HelpdeskAction): Statement[] {
  switch (action.type) {
    case 'reply':
      return [
        {
          sql: `INSERT INTO messages (ticket_id, author_kind, agent_id, body) VALUES ($1, $2, $3, $4) RETURNING id`,
          params: [id(action.ticketId), action.note ? 'note' : 'agent', id(action.agentId), text(action.body, MAX_BODY, 'empty_body')],
        },
      ]
    case 'update-ticket': {
      const sets: string[] = []
      const params: unknown[] = [id(action.ticketId)]
      const set = (column: string, value: unknown) => {
        params.push(value)
        sets.push(`${column} = $${params.length}`)
      }
      if (action.status !== undefined) {
        if (!statuses.includes(action.status)) throw new Error('invalid_input')
        set('status', action.status)
      }
      if (action.priority !== undefined) {
        if (!priorities.includes(action.priority)) throw new Error('invalid_input')
        set('priority', action.priority)
      }
      if (action.assigneeId !== undefined) set('assignee_id', action.assigneeId === null ? null : id(action.assigneeId))
      if (!sets.length) throw new Error('invalid_input')
      return [{ sql: `UPDATE tickets SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, params, expectRow: true }]
    }
    case 'create-ticket': {
      if (!priorities.includes(action.priority) || !channels.includes(action.channel)) throw new Error('invalid_input')
      const ticket = id(action.id)
      // Two statements: a ticket with no message yet is a valid state of its own (the triggers
      // derive nothing from it), so a failure between them leaves nothing inconsistent behind.
      return [
        {
          sql: `INSERT INTO tickets (id, subject, customer_id, assignee_id, priority, channel, tags) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          params: [
            ticket,
            text(action.subject, 200, 'empty_subject'),
            id(action.customerId),
            action.assigneeId === null ? null : id(action.assigneeId),
            action.priority,
            action.channel,
            parseTags(action.tags).join(','),
          ],
        },
        {
          sql: `INSERT INTO messages (ticket_id, author_kind, body) VALUES ($1, 'customer', $2) RETURNING id`,
          params: [ticket, text(action.body, MAX_BODY, 'empty_body')],
        },
      ]
    }
    case 'save-customer': {
      if (!plans.includes(action.plan)) throw new Error('invalid_input')
      const email = text(action.email, 200, 'invalid_email').toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid_email')
      const values = [text(action.name, 120, 'empty_name'), email, action.company.trim().slice(0, 120), action.plan]
      return action.id
        ? [
            {
              sql: `UPDATE customers SET name = $2, email = $3, company = $4, plan = $5 WHERE id = $1 RETURNING id`,
              params: [id(action.id), ...values],
              expectRow: true,
            },
          ]
        : [{ sql: `INSERT INTO customers (name, email, company, plan) VALUES ($1, $2, $3, $4) RETURNING id`, params: values }]
    }
    case 'set-sla':
      if (!priorities.includes(action.priority)) throw new Error('invalid_input')
      if (!isMinutes(action.firstResponseMinutes) || !isMinutes(action.resolutionMinutes)) throw new Error('invalid_minutes')
      if (action.resolutionMinutes < action.firstResponseMinutes) throw new Error('resolution_before_response')
      return [
        {
          sql: `INSERT INTO sla_policies (priority, first_response_minutes, resolution_minutes) VALUES ($1, $2, $3)
            ON CONFLICT (priority) DO UPDATE SET first_response_minutes = EXCLUDED.first_response_minutes,
            resolution_minutes = EXCLUDED.resolution_minutes RETURNING id`,
          params: [action.priority, action.firstResponseMinutes, action.resolutionMinutes],
        },
      ]
  }
}

/** The rules the triggers raise, by the code they raise with; anything else is shown as is. */
export const databaseErrors = [
  'helpdesk_ticket_closed',
  'helpdesk_close_unsolved',
  'helpdesk_first_response_derived',
  'helpdesk_agent_inactive',
  'helpdesk_message_before_ticket',
  'helpdesk_messages_append_only',
] as const
export function errorCode(message: string) {
  const known = databaseErrors.find((code) => message.includes(code))
  if (known) return known
  if (/customers_email/.test(message)) return 'email_taken'
  if (/violates check constraint/.test(message)) return 'invalid_input'
  return message
}

// ── SLA ──

const ms = (iso: string | null) => (iso ? Date.parse(iso) : NaN)
export const isUnsolved = (t: Pick<Ticket, 'status'>) => t.status === 'new' || t.status === 'open' || t.status === 'pending'
type Clocked = Pick<Ticket, 'status' | 'created_at' | 'response_due_at' | 'due_at' | 'first_response_at' | 'solved_at'>

/** Late first reply, or (for an unanswered ticket that is still open) a first reply now overdue. */
export function responseBreached(t: Clocked, now: number) {
  const due = ms(t.response_due_at)
  if (Number.isNaN(due)) return false
  if (t.first_response_at) return ms(t.first_response_at) > due
  return isUnsolved(t) && now > due
}
export function resolutionBreached(t: Clocked, now: number) {
  const due = ms(t.due_at)
  if (Number.isNaN(due)) return false
  return (t.solved_at ? ms(t.solved_at) : isUnsolved(t) ? now : -Infinity) > due
}
export const isBreached = (t: Clocked, now: number) => responseBreached(t, now) || resolutionBreached(t, now)

export type SlaState = {
  /** The current clock: running and soon count down, breached counts up; met and missed are final. */
  state: 'none' | 'running' | 'soon' | 'breached' | 'met' | 'missed'
  target: 'response' | 'resolution' | null
  dueAt: string | null
  /** Minutes until the current target; negative once it has passed. */
  minutes: number
  /** The first reply came after its target. The ticket counts as breached whatever the clock says. */
  lateReply: boolean
}
/**
 * The clock an agent cares about right now: the first-response target until someone replies,
 * then the resolution target. The clock keeps running while a ticket is pending; this template
 * does not pause SLAs while it waits on the customer.
 */
export function slaState(t: Clocked, now: number): SlaState {
  const lateReply = !!t.first_response_at && responseBreached(t, now)
  if (!isUnsolved(t)) {
    if (!t.due_at && !t.response_due_at) return { state: 'none', target: null, dueAt: null, minutes: 0, lateReply }
    return { state: isBreached(t, now) ? 'missed' : 'met', target: null, dueAt: t.due_at, minutes: 0, lateReply }
  }
  const target = t.first_response_at ? 'resolution' : 'response'
  const dueAt = target === 'response' ? t.response_due_at : t.due_at
  if (!dueAt) return { state: 'none', target: null, dueAt: null, minutes: 0, lateReply }
  const due = ms(dueAt)
  const minutes = Math.floor((due - now) / 60_000)
  const window = due - ms(t.created_at)
  const state = now > due ? 'breached' : due - now < window * SOON_SHARE ? 'soon' : 'running'
  return { state, target, dueAt, minutes, lateReply }
}

/**
 * The moment the data was last touched. The read-only demo is seeded once and then kept, so it
 * tells time by this instead of the wall clock; otherwise every open ticket would drift overdue.
 */
export function clockOf(data: Pick<HelpdeskData, 'tickets' | 'messages'>) {
  let latest = 0
  for (const t of data.tickets) latest = Math.max(latest, ms(t.last_activity_at), ms(t.created_at), t.solved_at ? ms(t.solved_at) : 0)
  for (const m of data.messages) latest = Math.max(latest, ms(m.created_at))
  return latest || Date.now()
}

// ── Inbox ──

export type InboxView = 'open' | 'unassigned' | 'mine' | 'urgent' | 'overdue' | 'solved'
export const inboxViews: InboxView[] = ['open', 'unassigned', 'mine', 'urgent', 'overdue', 'solved']
export function inView(t: Ticket, view: InboxView, me: string | null, now: number) {
  switch (view) {
    case 'open':
      return isUnsolved(t)
    case 'unassigned':
      return isUnsolved(t) && !t.assignee_id
    case 'mine':
      return isUnsolved(t) && !!me && t.assignee_id === me
    case 'urgent':
      return isUnsolved(t) && t.priority === 'urgent'
    case 'overdue':
      return isUnsolved(t) && isBreached(t, now)
    case 'solved':
      return !isUnsolved(t)
  }
}
/**
 * Open work sorts by the next deadline, most overdue first, then tickets without an SLA by age.
 * Solved work sorts by when it was solved, newest first.
 */
export function inboxTickets(tickets: Ticket[], view: InboxView, me: string | null, now: number) {
  const due = (t: Ticket) => {
    const s = slaState(t, now)
    return s.dueAt ? ms(s.dueAt) : Infinity
  }
  return tickets
    .filter((t) => inView(t, view, me, now))
    .sort((a, b) =>
      view === 'solved'
        ? ms(b.solved_at) - ms(a.solved_at) || b.id.localeCompare(a.id)
        : due(a) - due(b) || ms(a.created_at) - ms(b.created_at) || a.id.localeCompare(b.id),
    )
}
export function viewCounts(tickets: Ticket[], me: string | null, now: number) {
  return Object.fromEntries(inboxViews.map((v) => [v, tickets.filter((t) => inView(t, v, me, now)).length])) as Record<InboxView, number>
}
export function matchesSearch(t: Ticket, customer: Customer | undefined, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${t.subject} ${t.tags} ${customer?.name ?? ''} ${customer?.email ?? ''} ${customer?.company ?? ''}`.toLowerCase().includes(q)
}
/** Oldest first, the way a conversation reads. */
export const thread = (messages: Message[], ticketId: string) =>
  messages.filter((m) => m.ticket_id === ticketId).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
/**
 * True when the read window may have cut this ticket's thread short: the message read came back
 * full and the ticket is older than the oldest message it returned.
 */
export function threadMayBeTruncated(messages: Message[], ticket: Pick<Ticket, 'created_at'>) {
  if (messages.length < READ_WINDOW) return false
  const oldest = messages.reduce((min, m) => (m.created_at < min ? m.created_at : min), messages[0].created_at)
  return ticket.created_at < oldest
}

export function parseTags(value: string) {
  const tags = value
    .split(/[,，\s]+/)
    .map((t) => t.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean)
  return [...new Set(tags)].slice(0, 8)
}

// ── Reports ──

export function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
export const firstResponseMinutes = (t: Pick<Ticket, 'created_at' | 'first_response_at'>) =>
  t.first_response_at ? (ms(t.first_response_at) - ms(t.created_at)) / 60_000 : null
const since = (tickets: Ticket[], from: number) => tickets.filter((t) => ms(t.created_at) >= from)

export function medianFirstResponse(tickets: Ticket[], from = -Infinity) {
  return median(since(tickets, from).map(firstResponseMinutes).filter((m): m is number => m !== null))
}
/** Share of tickets with an SLA that missed either target, or are already past one while open. */
export function breachRate(tickets: Ticket[], now: number, from = -Infinity) {
  const measured = since(tickets, from).filter((t) => t.response_due_at || t.due_at)
  const breached = measured.filter((t) => isBreached(t, now)).length
  return { breached, total: measured.length, rate: measured.length ? breached / measured.length : null }
}
export function lastDays(endDay: string, count: number) {
  const end = Date.parse(endDay + 'T00:00:00Z')
  return Array.from({ length: count }, (_, i) => new Date(end - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10))
}
/** The calendar day of an instant in the viewer's time zone, as YYYY-MM-DD. */
export function localDay(iso: string | number) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** Tickets created and solved per day. `dayOf` maps an instant to its day; tests pass UTC. */
export function dailyVolume(tickets: Ticket[], days: string[], dayOf: (iso: string) => string = localDay) {
  const rows = new Map(days.map((day) => [day, { day, created: 0, solved: 0 }]))
  for (const t of tickets) {
    const created = rows.get(dayOf(t.created_at))
    if (created) created.created++
    const solved = t.solved_at ? rows.get(dayOf(t.solved_at)) : undefined
    if (solved) solved.solved++
  }
  return [...rows.values()]
}
export function backlogByPriority(tickets: Ticket[]) {
  return priorities.map((priority) => ({
    priority,
    count: tickets.filter((t) => isUnsolved(t) && t.priority === priority).length,
  }))
}
/** Solved (or closed) per agent since `from`, by when they were solved. Agents who solved none are left out. */
export function solvedByAgent(tickets: Ticket[], agents: Agent[], from = -Infinity) {
  const counts = new Map<string, number>()
  for (const t of tickets)
    if (t.assignee_id && t.solved_at && ms(t.solved_at) >= from) counts.set(t.assignee_id, (counts.get(t.assignee_id) ?? 0) + 1)
  return agents
    .filter((a) => counts.has(a.id))
    .map((agent) => ({ agent, solved: counts.get(agent.id)! }))
    .sort((a, b) => b.solved - a.solved || a.agent.name.localeCompare(b.agent.name))
}

// ── Formatting ──

/** 45m, 3h 20m, 2d 4h — or the Chinese equivalents. Whole minutes, sign dropped. */
export function duration(minutes: number, locale: Locale) {
  const m = Math.round(Math.abs(minutes))
  const [d, h, mm] = [Math.floor(m / 1440), Math.floor((m % 1440) / 60), m % 60]
  const unit = locale === 'zh' ? { d: '天', h: '小时', m: '分' } : { d: 'd', h: 'h', m: 'm' }
  const gap = locale === 'zh' ? '' : ' '
  if (d) return `${d}${unit.d}${h ? gap + h + unit.h : ''}`
  if (h) return `${h}${unit.h}${mm ? gap + mm + unit.m : ''}`
  return `${mm}${unit.m}`
}
/** 5m, 3h, 2d for recent activity; a short date beyond a week. */
export function ago(iso: string, now: number, locale: Locale) {
  const minutes = Math.max(0, (now - ms(iso)) / 60_000)
  if (minutes < 1) return locale === 'zh' ? '刚刚' : 'now'
  if (minutes < 7 * 1440) return duration(minutes >= 1440 ? Math.floor(minutes / 1440) * 1440 : minutes >= 60 ? Math.floor(minutes / 60) * 60 : minutes, locale)
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' }).format(new Date(iso))
}
export const initials = (name: string) => {
  const parts = name.trim().split(/\s+/)
  if (/[一-鿿]/.test(name)) return name.trim().slice(-2)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}
