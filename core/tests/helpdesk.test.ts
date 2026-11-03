import { describe, expect, test } from 'bun:test'
import {
  READ_WINDOW,
  actionStatements,
  ago,
  backlogByPriority,
  breachRate,
  clockOf,
  dailyVolume,
  duration,
  errorCode,
  inboxTickets,
  initials,
  isBreached,
  lastDays,
  matchesSearch,
  median,
  medianFirstResponse,
  parseTags,
  slaState,
  solvedByAgent,
  thread,
  threadMayBeTruncated,
  viewCounts,
  type Agent,
  type Message,
  type Ticket,
} from '../src/helpdesk'

const T0 = Date.parse('2026-11-01T00:00:00Z')
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()
/** A normal-priority ticket: first reply due after 4 hours, resolution after 72. */
const ticket = (id: string, over: Partial<Ticket> = {}): Ticket => ({
  id,
  created_at: at(0),
  subject: `Ticket ${id}`,
  customer_id: 'c1',
  assignee_id: null,
  status: 'new',
  priority: 'normal',
  channel: 'email',
  tags: '',
  response_due_at: at(240),
  due_at: at(72 * 60),
  first_response_at: null,
  solved_at: null,
  last_activity_at: at(0),
  ...over,
})
const agent = (id: string, name: string, active = true): Agent => ({ id, created_at: at(-1000), name, email: `${id}@x.test`, team: 'frontline', active })

describe('SLA clock', () => {
  test('counts down to the first response, then to resolution', () => {
    const fresh = ticket('a')
    expect(slaState(fresh, T0 + 60 * 60_000)).toEqual({ state: 'running', target: 'response', dueAt: at(240), minutes: 180, lateReply: false })
    // Less than a quarter of the four hours left.
    expect(slaState(fresh, T0 + 200 * 60_000).state).toBe('soon')
    const answered = ticket('b', { status: 'open', first_response_at: at(30) })
    expect(slaState(answered, T0 + 300 * 60_000)).toMatchObject({ state: 'running', target: 'resolution', dueAt: at(72 * 60) })
  })
  test('an unanswered ticket past its target is breached and counts up', () => {
    const s = slaState(ticket('a'), T0 + 300 * 60_000)
    expect(s).toMatchObject({ state: 'breached', target: 'response', minutes: -60 })
    expect(duration(s.minutes, 'en')).toBe('1h')
  })
  test('a late first reply stays a breach even after the clock moves on', () => {
    const late = ticket('a', { status: 'open', first_response_at: at(300) })
    expect(isBreached(late, T0 + 301 * 60_000)).toBe(true)
    expect(slaState(late, T0 + 301 * 60_000)).toMatchObject({ state: 'running', target: 'resolution', lateReply: true })
    expect(slaState(ticket('a', { status: 'open', first_response_at: at(30) }), T0).lateReply).toBe(false)
  })
  test('solved tickets end met or missed', () => {
    expect(slaState(ticket('a', { status: 'solved', first_response_at: at(10), solved_at: at(100) }), T0 + 1e9).state).toBe('met')
    expect(slaState(ticket('a', { status: 'closed', first_response_at: at(10), solved_at: at(73 * 60) }), T0).state).toBe('missed')
    // Solved without any reply: the unanswered clock stops with the ticket.
    expect(isBreached(ticket('a', { status: 'solved', solved_at: at(10) }), T0 + 1e9)).toBe(false)
    expect(slaState(ticket('a', { response_due_at: null, due_at: null }), T0).state).toBe('none')
  })
})

describe('inbox views', () => {
  const now = T0 + 300 * 60_000
  const tickets = [
    ticket('new-unassigned', { created_at: at(100), response_due_at: at(340), last_activity_at: at(100) }),
    ticket('overdue', { status: 'new' }),
    ticket('mine', { status: 'open', assignee_id: 'me', first_response_at: at(20), priority: 'urgent', due_at: at(480) }),
    ticket('pending-other', { status: 'pending', assignee_id: 'other', first_response_at: at(20) }),
    ticket('solved-early', { status: 'solved', assignee_id: 'me', first_response_at: at(20), solved_at: at(60) }),
    ticket('closed-late', { status: 'closed', assignee_id: 'other', first_response_at: at(20), solved_at: at(120) }),
  ]
  const ids = (view: Parameters<typeof inboxTickets>[1], me: string | null = 'me') => inboxTickets(tickets, view, me, now).map((t) => t.id)
  test('each view filters and orders by the next deadline', () => {
    expect(ids('open')).toEqual(['overdue', 'new-unassigned', 'mine', 'pending-other'])
    expect(ids('unassigned')).toEqual(['overdue', 'new-unassigned'])
    expect(ids('mine')).toEqual(['mine'])
    expect(ids('mine', null)).toEqual([])
    expect(ids('urgent')).toEqual(['mine'])
    expect(ids('overdue')).toEqual(['overdue'])
    expect(ids('solved')).toEqual(['closed-late', 'solved-early'])
    expect(viewCounts(tickets, 'me', now)).toEqual({ open: 4, unassigned: 2, mine: 1, urgent: 1, overdue: 1, solved: 2 })
  })
  test('search covers subject, tags and the customer', () => {
    const customer = { id: 'c1', created_at: '', name: 'Grace Kim', email: 'grace@kestrel.example', company: 'Kestrel Health', plan: 'pro' as const }
    expect(matchesSearch(ticket('x', { tags: 'sso,login' }), customer, 'SSO')).toBe(true)
    expect(matchesSearch(ticket('x'), customer, 'kestrel')).toBe(true)
    expect(matchesSearch(ticket('x'), customer, 'invoice')).toBe(false)
    expect(matchesSearch(ticket('x'), undefined, '  ')).toBe(true)
  })
  test('threads read oldest first and know when the read window cut them short', () => {
    const message = (id: string, minutes: number, ticketId = 'a'): Message => ({ id, created_at: at(minutes), ticket_id: ticketId, author_kind: 'customer', agent_id: null, body: id })
    expect(thread([message('2', 5), message('1', 1), message('x', 0, 'b')], 'a').map((m) => m.id)).toEqual(['1', '2'])
    const full = Array.from({ length: READ_WINDOW }, (_, i) => message(String(i), 100 + i, 'z'))
    expect(threadMayBeTruncated(full, ticket('old', { created_at: at(50) }))).toBe(true)
    expect(threadMayBeTruncated(full, ticket('new', { created_at: at(150) }))).toBe(false)
    expect(threadMayBeTruncated(full.slice(1), ticket('old', { created_at: at(50) }))).toBe(false)
  })
  test('the demo clock is its latest activity', () => {
    expect(clockOf({ tickets: [ticket('a', { last_activity_at: at(30) })], messages: [] })).toBe(T0 + 30 * 60_000)
  })
})

describe('reports', () => {
  test('median first response', () => {
    expect(median([])).toBeNull()
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    const tickets = [
      ticket('a', { first_response_at: at(10) }),
      ticket('b', { first_response_at: at(30) }),
      ticket('c', { first_response_at: at(90) }),
      ticket('d'),
      ticket('old', { created_at: at(-50_000), first_response_at: at(-1) }),
    ]
    expect(medianFirstResponse(tickets, T0)).toBe(30)
    expect(medianFirstResponse([ticket('d')])).toBeNull()
  })
  test('breach rate counts late replies, late solves and open tickets already past due', () => {
    const now = T0 + 300 * 60_000
    const tickets = [
      ticket('on-time', { status: 'solved', first_response_at: at(10), solved_at: at(60) }),
      ticket('late-reply', { status: 'open', first_response_at: at(250) }),
      ticket('unanswered', {}),
      ticket('fresh', { created_at: at(200), response_due_at: at(440) }),
      ticket('no-sla', { response_due_at: null, due_at: null }),
    ]
    expect(breachRate(tickets, now)).toEqual({ breached: 2, total: 4, rate: 0.5 })
    expect(breachRate([], now).rate).toBeNull()
  })
  test('daily volume, backlog and agent leaderboard', () => {
    const days = lastDays('2026-11-02', 3)
    expect(days).toEqual(['2026-10-31', '2026-11-01', '2026-11-02'])
    const tickets = [
      ticket('a', { created_at: '2026-10-31T23:00:00Z', status: 'solved', solved_at: '2026-11-01T02:00:00Z', assignee_id: 'mia' }),
      ticket('b', { created_at: '2026-11-01T08:00:00Z', priority: 'urgent', status: 'open' }),
      ticket('c', { created_at: '2026-11-02T08:00:00Z', status: 'closed', solved_at: '2026-11-02T09:00:00Z', assignee_id: 'tom' }),
      ticket('d', { created_at: '2026-11-02T09:00:00Z', status: 'solved', solved_at: '2026-11-02T10:00:00Z', assignee_id: 'mia' }),
      ticket('e', { created_at: '2026-09-01T00:00:00Z', priority: 'low' }),
    ]
    expect(dailyVolume(tickets, days, (iso) => iso.slice(0, 10))).toEqual([
      { day: '2026-10-31', created: 1, solved: 0 },
      { day: '2026-11-01', created: 1, solved: 1 },
      { day: '2026-11-02', created: 2, solved: 2 },
    ])
    expect(backlogByPriority(tickets)).toEqual([
      { priority: 'urgent', count: 1 },
      { priority: 'high', count: 0 },
      { priority: 'normal', count: 0 },
      { priority: 'low', count: 1 },
    ])
    const agents = [agent('mia', 'Mia Chen'), agent('tom', 'Tom Becker', false), agent('idle', 'Idle')]
    expect(solvedByAgent(tickets, agents).map((r) => [r.agent.id, r.solved])).toEqual([['mia', 2], ['tom', 1]])
    expect(solvedByAgent(tickets, agents, Date.parse('2026-11-02T00:00:00Z')).map((r) => [r.agent.id, r.solved])).toEqual([['mia', 1], ['tom', 1]])
  })
  test('durations and labels in both languages', () => {
    expect(duration(45, 'en')).toBe('45m')
    expect(duration(200, 'en')).toBe('3h 20m')
    expect(duration(-(2 * 1440 + 240), 'en')).toBe('2d 4h')
    expect(duration(200, 'zh')).toBe('3小时20分')
    expect(ago(at(0), T0 + 90 * 60_000, 'en')).toBe('1h')
    expect(ago(at(0), T0 + 20_000, 'zh')).toBe('刚刚')
    expect(initials('Grace Kim')).toBe('GK')
    expect(initials('陈思远')).toBe('思远')
    expect(parseTags(' SSO, login，sso  bug!')).toEqual(['sso', 'login', 'bug'])
  })
})

describe('statements', () => {
  const id = '6f1d3c3e-8a51-4d55-9a3c-1a2b3c4d5e6f'
  test('a reply is one insert; a note is the same insert with another kind', () => {
    const [reply] = actionStatements({ type: 'reply', ticketId: id, agentId: id, body: ' Hello ', note: false })
    expect(reply.sql).toStartWith('INSERT INTO messages')
    expect(reply.params).toEqual([id, 'agent', id, 'Hello'])
    expect(actionStatements({ type: 'reply', ticketId: id, agentId: id, body: 'x', note: true })[0].params[1]).toBe('note')
    expect(() => actionStatements({ type: 'reply', ticketId: id, agentId: id, body: '   ', note: false })).toThrow('empty_body')
    expect(() => actionStatements({ type: 'reply', ticketId: 'nope', agentId: id, body: 'x', note: false })).toThrow('invalid_input')
  })
  test('ticket updates set only what changed and expect the row back', () => {
    const [s] = actionStatements({ type: 'update-ticket', ticketId: id, status: 'solved', assigneeId: null })
    expect(s.sql).toBe('UPDATE tickets SET status = $2, assignee_id = $3 WHERE id = $1 RETURNING id')
    expect(s.params).toEqual([id, 'solved', null])
    expect(s.expectRow).toBe(true)
    expect(() => actionStatements({ type: 'update-ticket', ticketId: id })).toThrow('invalid_input')
    expect(() => actionStatements({ type: 'update-ticket', ticketId: id, status: 'gone' as never })).toThrow('invalid_input')
  })
  test('creating a ticket is the ticket, then its opening message; never anything derived', () => {
    const statements = actionStatements({
      type: 'create-ticket', id, customerId: id, subject: 'Help', body: 'It broke', priority: 'high', channel: 'phone', assigneeId: null, tags: 'Bug, bug',
    })
    expect(statements.map((s) => s.sql.split(' (')[0])).toEqual(['INSERT INTO tickets', 'INSERT INTO messages'])
    expect(statements[0].params).toEqual([id, 'Help', id, null, 'high', 'phone', 'bug'])
    expect(statements.every((s) => !/due_at|first_response_at|solved_at|status/.test(s.sql))).toBe(true)
  })
  test('customers and SLA policies are validated before they reach the database', () => {
    const save = (over: object) => () => actionStatements({ type: 'save-customer', name: 'A', email: 'a@b.co', company: '', plan: 'free', ...over } as never)
    expect(save({})()[0].params).toEqual(['A', 'a@b.co', '', 'free'])
    expect(save({ id, email: 'A@B.CO' })()[0].params).toEqual([id, 'A', 'a@b.co', '', 'free'])
    expect(save({ email: 'nope' })).toThrow('invalid_email')
    expect(save({ name: ' ' })).toThrow('empty_name')
    const sla = (first: number, resolution: number) => () => actionStatements({ type: 'set-sla', priority: 'high', firstResponseMinutes: first, resolutionMinutes: resolution })
    expect(sla(60, 600)()[0].sql).toContain('ON CONFLICT (priority) DO UPDATE')
    expect(sla(0, 600)).toThrow('invalid_minutes')
    expect(sla(1.5, 600)).toThrow('invalid_minutes')
    expect(sla(600, 60)).toThrow('resolution_before_response')
  })
  test('database errors map to their codes', () => {
    expect(errorCode('helpdesk_ticket_closed (at position 3)')).toBe('helpdesk_ticket_closed')
    expect(errorCode('duplicate key value violates unique constraint "customers_email_key"')).toBe('email_taken')
    expect(errorCode('new row violates check constraint "x"')).toBe('invalid_input')
    expect(errorCode('something else')).toBe('something else')
  })
})
