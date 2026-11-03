import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import {
  ArrowLeft,
  ChartColumn,
  CircleCheck,
  Clock,
  Flag,
  Globe,
  Inbox,
  Lock,
  Mail,
  MessageCircle,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Send,
  StickyNote,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react'
import {
  READ_WINDOW,
  ago,
  backlogByPriority,
  breachRate,
  channels,
  clockOf,
  dailyVolume,
  duration,
  errorCode,
  firstResponseMinutes,
  inboxTickets,
  inboxViews,
  initials,
  isUnsolved,
  lastDays,
  localDay,
  matchesSearch,
  medianFirstResponse,
  plans,
  priorities,
  slaState,
  solvedByAgent,
  statuses,
  thread,
  threadMayBeTruncated,
  viewCounts,
  type Agent,
  type Channel,
  type Customer,
  type HelpdeskAction,
  type HelpdeskClient,
  type HelpdeskData,
  type InboxView,
  type Locale,
  type Plan,
  type Priority,
  type SlaPolicy,
  type Status,
  type Ticket,
} from '@lovbase/core/helpdesk'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { translate } from './labels'
import './helpdesk.css'

type Page = 'inbox' | 'customers' | 'reports'
type Form = { type: 'ticket'; customerId?: string } | { type: 'customer'; customer?: Customer } | { type: 'sla'; policy: SlaPolicy }
type T = (key: string) => string

const navigation: [Page, typeof Inbox][] = [
  ['inbox', Inbox],
  ['customers', Users],
  ['reports', ChartColumn],
]
const channelIcons: Record<Channel, typeof Mail> = { email: Mail, chat: MessageCircle, phone: Phone, web: Globe }
const AGENT_KEY = 'helpdesk.agent'
const DAY = 86_400_000
/** Eight hues that read on white, picked by id so a person keeps their colour everywhere. */
const hues = [252, 200, 340, 28, 160, 290, 12, 220]
const hueOf = (id: string) => hues[[...id].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7) % hues.length]

function storedAgent() {
  try {
    return localStorage.getItem(AGENT_KEY)
  } catch {
    return null
  }
}
function storeAgent(id: string) {
  try {
    localStorage.setItem(AGENT_KEY, id)
  } catch {}
}
function dateTime(iso: string, locale: Locale) {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso))
}
function dayLabel(day: string, locale: Locale) {
  const [y, m, d] = day.split('-').map(Number)
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  )
}
/** A live clock for a working copy. The read-only demo freezes at its last activity instead. */
function useNow(frozen: number | null) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (frozen !== null) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [frozen])
  return frozen ?? now
}

export function HelpdeskApp({
  client,
  initialLocale = 'en',
  locale: controlledLocale,
  onLocaleChange,
  initialData,
}: {
  client: HelpdeskClient
  initialLocale?: Locale
  locale?: Locale
  onLocaleChange?: (locale: Locale) => void
  initialData?: HelpdeskData
}) {
  const [localLocale, setLocalLocale] = useState<Locale>(initialLocale)
  const locale = controlledLocale ?? localLocale
  const t: T = (key) => translate(locale, key)
  const [data, setData] = useState<HelpdeskData | null>(initialData ?? null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(!initialData)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [page, setPage] = useState<Page>('inbox')
  const [view, setView] = useState<InboxView>('open')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Phones show one pane at a time: the queue, or the ticket opened from it.
  const [pane, setPane] = useState<'list' | 'ticket'>('list')
  const [query, setQuery] = useState('')
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [me, setMe] = useState<string | null>(storedAgent)

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
  const now = useNow(data?.readOnly ? clockOf(data) : null)

  /** Runs one action, then rereads: the triggers may have changed more than the row written. */
  const run = async (action: HelpdeskAction) => {
    if (busy || data?.readOnly) return false
    setBusy(true)
    setActionError('')
    try {
      await client.run(action)
      setData(await client.read())
      return true
    } catch (e) {
      setActionError(errorCode(e instanceof Error ? e.message : 'generic_error'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const lookup = useMemo(() => {
    if (!data) return null
    const customers = new Map(data.customers.map((c) => [c.id, c]))
    const agents = new Map(data.agents.map((a) => [a.id, a]))
    const active = data.agents.filter((a) => a.active)
    return { customers, agents, active }
  }, [data])

  // The person the inbox is for: the remembered agent if still active, else whoever holds the
  // most open tickets, so "Assigned to me" starts with something in it.
  const agentId = useMemo(() => {
    if (!lookup || !data) return null
    if (me && lookup.active.some((a) => a.id === me)) return me
    const load = (id: string) => data.tickets.filter((tk) => tk.assignee_id === id && isUnsolved(tk)).length
    return lookup.active.reduce<string | null>((best, a) => (best === null || load(a.id) > load(best) ? a.id : best), null)
  }, [lookup, data, me])
  const chooseAgent = (id: string) => {
    setMe(id)
    storeAgent(id)
  }

  if (!data || !lookup)
    return (
      <div className="helpdesk-app hd-center">
        {error ? (
          <div>
            <p>{t(error)}</p>
            <button onClick={() => void read()}>{t('retry')}</button>
          </div>
        ) : (
          <p className="hd-muted">{loading ? t('loading') : ''}</p>
        )}
      </div>
    )

  const { customers, agents, active } = lookup
  const counts = viewCounts(data.tickets, agentId, now)
  const queue = inboxTickets(data.tickets, view, agentId, now).filter((tk) => matchesSearch(tk, customers.get(tk.customer_id), query))
  // A ticket stays open after an edit moves it out of the current view; otherwise the desktop
  // shows the top of the queue, and a phone shows the queue itself.
  const selected = data.tickets.find((tk) => tk.id === selectedId) ?? (pane === 'list' ? queue[0] : undefined) ?? null
  const openTicket = (ticket: Ticket) => {
    setSelectedId(ticket.id)
    setActionError('')
    setPane('ticket')
  }
  const showTicket = (ticket: Ticket) => {
    setPage('inbox')
    setQuery('')
    if (!inboxTickets([ticket], view, agentId, now).length) setView(isUnsolved(ticket) ? 'open' : 'solved')
    openTicket(ticket)
  }
  const truncated = data.tickets.length >= READ_WINDOW

  const inbox = (
    <div className={`hd-inbox hd-pane-${pane}`}>
      <nav className="hd-views" aria-label={t('views')}>
        <p className="hd-section-label">{t('views')}</p>
        {inboxViews.map((v) => (
          <button
            key={v}
            aria-current={view === v ? 'true' : undefined}
            className={`hd-view hd-view-${v}`}
            onClick={() => {
              setView(v)
              setSelectedId(null)
            }}
          >
            <i aria-hidden />
            <span>{t(`view_${v}`)}</span>
            <em>{counts[v]}</em>
          </button>
        ))}
        {truncated && <p className="hd-window">{t('ticketWindow')}</p>}
      </nav>
      <section className="hd-queue" aria-label={t(`view_${view}`)}>
        <header className="hd-queue-head">
          <h2>{t(`view_${view}`)}</h2>
          <span>{queue.length}</span>
        </header>
        <label className="hd-search">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search')} />
        </label>
        {queue.length === 0 ? (
          <div className="hd-empty">
            <CircleCheck size={22} />
            <p>{view === 'mine' && !agentId ? t('pickAgent') : t('emptyView')}</p>
          </div>
        ) : (
          <ul className="hd-tickets">
            {queue.map((ticket) => (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                customer={customers.get(ticket.customer_id)}
                assignee={ticket.assignee_id ? agents.get(ticket.assignee_id) : undefined}
                selected={selected?.id === ticket.id}
                now={now}
                locale={locale}
                t={t}
                onOpen={() => openTicket(ticket)}
              />
            ))}
          </ul>
        )}
      </section>
      {selected ? (
        <TicketPane
          key={selected.id}
          data={data}
          ticket={selected}
          customer={customers.get(selected.customer_id)}
          agents={agents}
          active={active}
          agentId={agentId}
          now={now}
          locale={locale}
          t={t}
          busy={busy}
          error={actionError}
          onBack={() => setPane('list')}
          onRun={run}
          onOpenTicket={openTicket}
        />
      ) : (
        <section className="hd-thread hd-thread-empty">
          <Inbox size={28} />
          <p>{t('noSelection')}</p>
        </section>
      )}
    </div>
  )

  const content = {
    inbox,
    customers: (
      <CustomersPage
        data={data}
        now={now}
        locale={locale}
        t={t}
        selectedId={customerId}
        onSelect={setCustomerId}
        onEdit={(customer) => setForm({ type: 'customer', customer })}
        onNewTicket={(customer) => setForm({ type: 'ticket', customerId: customer.id })}
        onShowTicket={showTicket}
      />
    ),
    reports: <ReportsPage data={data} now={now} locale={locale} t={t} onEditSla={(policy) => setForm({ type: 'sla', policy })} />,
  }[page]

  return (
    <div className="helpdesk-app">
      <aside className="hd-rail">
        <div className="hd-mark" aria-label={t('brand')} title={t('brand')}>
          <MessageCircle size={18} strokeWidth={2.4} />
        </div>
        <nav>
          {navigation.map(([id, Icon]) => (
            <button key={id} aria-current={page === id ? 'page' : undefined} title={t(id)} onClick={() => setPage(id)}>
              <Icon size={19} />
              <span>{t(id)}</span>
            </button>
          ))}
        </nav>
      </aside>
      <div className="hd-body">
        <header className="hd-topbar">
          <div className="hd-heading">
            <strong>{t('brand')}</strong>
            <span>{t(`${page}Subtitle`)}</span>
          </div>
          <div className="hd-toolbar">
            {active.length > 0 && (
              <div className="hd-me">
                <span className="hd-me-label">{t('viewingAs')}</span>
                <Choice
                  label={t('viewingAs')}
                  value={agentId ?? ''}
                  onChange={chooseAgent}
                  options={active.map((a): [string, ReactNode] => [a.id, <AgentOption key={a.id} agent={a} />])}
                  className="hd-me-select"
                />
              </div>
            )}
            <div className="hd-language" aria-label={t('language')}>
              {(['zh', 'en'] as const).map((l) => (
                <button key={l} aria-pressed={locale === l} onClick={() => switchLocale(l)}>
                  {l === 'zh' ? '中文' : 'EN'}
                </button>
              ))}
            </div>
            <button className="hd-icon" aria-label={t('refresh')} title={t('refresh')} disabled={loading} onClick={() => void read()}>
              <RefreshCw size={15} />
            </button>
            {!data.readOnly && (
              <button className="hd-primary" onClick={() => setForm({ type: 'ticket' })}>
                <Plus size={15} />
                <span>{t('newTicket')}</span>
              </button>
            )}
          </div>
        </header>
        {data.readOnly && (
          <div className="hd-demo">
            <Lock size={13} />
            {t('readonly')}
          </div>
        )}
        <main className={`hd-main hd-main-${page}`}>{content}</main>
      </div>
      {form && (
        <Modal
          title={form.type === 'ticket' ? t('newTicket') : form.type === 'customer' ? t(form.customer ? 'editCustomer' : 'addCustomer') : `${t('slaPolicy')} · ${t(form.policy.priority)}`}
          onClose={() => !busy && setForm(null)}
        >
          {form.type === 'ticket' && (
            <TicketForm
              customers={data.customers}
              active={active}
              initialCustomer={form.customerId}
              agentId={agentId}
              t={t}
              busy={busy}
              error={actionError}
              onCancel={() => setForm(null)}
              onSubmit={async (action) => {
                if (await run(action)) {
                  setForm(null)
                  setPage('inbox')
                  setView('open')
                  setQuery('')
                  setSelectedId(action.id)
                  setPane('ticket')
                }
              }}
            />
          )}
          {form.type === 'customer' && (
            <CustomerForm
              customer={form.customer}
              t={t}
              busy={busy}
              error={actionError}
              onCancel={() => setForm(null)}
              onSubmit={async (action) => {
                if (await run(action)) setForm(null)
              }}
            />
          )}
          {form.type === 'sla' && (
            <SlaForm
              policy={form.policy}
              t={t}
              busy={busy}
              error={actionError}
              onCancel={() => setForm(null)}
              onSubmit={async (action) => {
                if (await run(action)) setForm(null)
              }}
            />
          )}
        </Modal>
      )}
    </div>
  )
}

// ── Inbox pieces ──

function Avatar({ id, name, size = 'md', person = 'agent' }: { id: string; name: string; size?: 'xs' | 'sm' | 'md' | 'lg'; person?: 'agent' | 'customer' }) {
  return (
    <span className={`hd-avatar hd-avatar-${size} hd-avatar-${person}`} style={{ '--hue': hueOf(id) } as CSSProperties} aria-hidden>
      {initials(name)}
    </span>
  )
}
function AgentOption({ agent }: { agent: Agent }) {
  return (
    <span className="hd-agent-option">
      <Avatar id={agent.id} name={agent.name} size="xs" />
      {agent.name}
    </span>
  )
}

function StatusPill({ status, t }: { status: Status; t: T }) {
  return <span className={`hd-status hd-status-${status}`}>{t(status)}</span>
}
function PriorityMark({ priority, t, always }: { priority: Priority; t: T; always?: boolean }) {
  if (!always && (priority === 'normal' || priority === 'low')) return null
  return (
    <span className={`hd-priority hd-priority-${priority}`}>
      <Flag size={11} strokeWidth={2.4} />
      {t(priority)}
    </span>
  )
}
function SlaBadge({ ticket, now, locale, t }: { ticket: Ticket; now: number; locale: Locale; t: T }) {
  const s = slaState(ticket, now)
  if (s.state === 'none' || s.state === 'met') return null
  if (s.state === 'missed')
    return (
      <span className="hd-sla hd-sla-missed" title={t('slaMissed')}>
        <TriangleAlert size={11} />
        {t('slaMissed')}
      </span>
    )
  const label = s.minutes < 0 ? `${duration(s.minutes, locale)} ${t('over')}` : duration(s.minutes, locale)
  return (
    <>
      {s.lateReply && s.state !== 'breached' && (
        <span className="hd-sla hd-sla-breached" title={t('slaMissed')}>
          <TriangleAlert size={11} />
          {t('lateReply')}
        </span>
      )}
      <span className={`hd-sla hd-sla-${s.state}`} title={`${t(s.target === 'response' ? 'firstResponse' : 'resolution')} · ${label}`}>
        {s.state === 'breached' ? <TriangleAlert size={11} /> : <Clock size={11} />}
        {s.target === 'response' ? t('replyIn') : t('solveIn')} {label}
      </span>
    </>
  )
}

function TicketRow({
  ticket,
  customer,
  assignee,
  selected,
  now,
  locale,
  t,
  onOpen,
}: {
  ticket: Ticket
  customer?: Customer
  assignee?: Agent
  selected: boolean
  now: number
  locale: Locale
  t: T
  onOpen: () => void
}) {
  const Icon = channelIcons[ticket.channel]
  return (
    <li>
      <button className={`hd-ticket${selected ? ' is-selected' : ''}${ticket.status === 'new' ? ' is-new' : ''}`} aria-current={selected ? 'true' : undefined} onClick={onOpen}>
        <div className="hd-ticket-top">
          <span className="hd-ticket-customer">
            <Icon size={12} />
            {customer?.name ?? '—'}
            {customer?.company && <em> · {customer.company}</em>}
          </span>
          <time>{ago(ticket.last_activity_at, now, locale)}</time>
        </div>
        <strong className="hd-ticket-subject">{ticket.subject}</strong>
        <div className="hd-ticket-meta">
          <StatusPill status={ticket.status} t={t} />
          <PriorityMark priority={ticket.priority} t={t} />
          <SlaBadge ticket={ticket} now={now} locale={locale} t={t} />
          <span className="hd-ticket-assignee">
            {assignee ? <Avatar id={assignee.id} name={assignee.name} size="xs" /> : <span className="hd-unassigned" title={t('unassigned')} />}
          </span>
        </div>
      </button>
    </li>
  )
}

function TicketPane({
  data,
  ticket,
  customer,
  agents,
  active,
  agentId,
  now,
  locale,
  t,
  busy,
  error,
  onBack,
  onRun,
  onOpenTicket,
}: {
  data: HelpdeskData
  ticket: Ticket
  customer?: Customer
  agents: Map<string, Agent>
  active: Agent[]
  agentId: string | null
  now: number
  locale: Locale
  t: T
  busy: boolean
  error: string
  onBack: () => void
  onRun: (action: HelpdeskAction) => Promise<boolean>
  onOpenTicket: (ticket: Ticket) => void
}) {
  const messages = thread(data.messages, ticket.id)
  const partial = threadMayBeTruncated(data.messages, ticket)
  // Conversations read bottom-up: land on the latest message, and follow new ones.
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight
  }, [messages.length])
  const readOnly = data.readOnly
  const closed = ticket.status === 'closed'
  const Icon = channelIcons[ticket.channel]
  const update = (patch: Omit<Extract<HelpdeskAction, { type: 'update-ticket' }>, 'type' | 'ticketId'>) =>
    void onRun({ type: 'update-ticket', ticketId: ticket.id, ...patch })
  // Agents who have left keep their name on old tickets but are not offered for new work.
  const assignable = ticket.assignee_id && !active.some((a) => a.id === ticket.assignee_id) ? [...active, agents.get(ticket.assignee_id)!].filter(Boolean) : active

  return (
    <>
      <section className="hd-thread" aria-label={ticket.subject}>
        <header className="hd-thread-head">
          <button className="hd-icon hd-back" aria-label={t('back')} onClick={onBack}>
            <ArrowLeft size={17} />
          </button>
          <div className="hd-thread-title">
            <h1>{ticket.subject}</h1>
            <p>
              <Icon size={12} />
              {t(ticket.channel)} · #{ticket.id.slice(0, 6).toUpperCase()} · {dateTime(ticket.created_at, locale)}
              <span className="hd-thread-customer"> · {customer?.name}</span>
            </p>
          </div>
          {!readOnly && !closed && ticket.status !== 'solved' && (
            <button className="hd-solve" disabled={busy} onClick={() => update({ status: 'solved' })}>
              <CircleCheck size={14} />
              {t('markSolved')}
            </button>
          )}
        </header>
        <div className="hd-controls">
          {readOnly || closed ? (
            <>
              <StatusPill status={ticket.status} t={t} />
              <PriorityMark priority={ticket.priority} t={t} always />
              <span className="hd-assignee-static">
                {ticket.assignee_id ? <Avatar id={ticket.assignee_id} name={agents.get(ticket.assignee_id)?.name ?? '?'} size="xs" /> : null}
                {ticket.assignee_id ? agents.get(ticket.assignee_id)?.name : t('unassigned')}
              </span>
            </>
          ) : (
            <>
              <Control label={t('status')}>
                <Choice
                  label={t('status')}
                  value={ticket.status}
                  onChange={(v) => update({ status: v as Status })}
                  options={statuses
                    // Closing is a step after solving; the database rejects it from anywhere else.
                    .filter((s) => s !== 'closed' || ticket.status === 'solved')
                    .map((s): [string, ReactNode] => [s, <StatusPill key={s} status={s} t={t} />])}
                />
              </Control>
              <Control label={t('priority')}>
                <Choice
                  label={t('priority')}
                  value={ticket.priority}
                  onChange={(v) => update({ priority: v as Priority })}
                  options={priorities.map((p): [string, ReactNode] => [p, <PriorityMark key={p} priority={p} t={t} always />])}
                />
              </Control>
              <Control label={t('assignee')}>
                <Choice
                  label={t('assignee')}
                  value={ticket.assignee_id ?? ''}
                  onChange={(v) => update({ assigneeId: v || null })}
                  options={[
                    ['', t('unassigned')],
                    ...assignable.map((a): [string, ReactNode] => [
                      a.id,
                      <span key={a.id} className="hd-agent-option">
                        <Avatar id={a.id} name={a.name} size="xs" />
                        {a.name}
                      </span>,
                    ]),
                  ]}
                />
              </Control>
            </>
          )}
        </div>
        {error && <p className="hd-error hd-thread-error">{t(error)}</p>}
        <ol className="hd-messages" ref={list}>
          {partial && <li className="hd-partial">{t('threadWindow')}</li>}
          {messages.map((m) => {
            const author = m.agent_id ? agents.get(m.agent_id) : undefined
            return (
              <li key={m.id} className={`hd-message hd-message-${m.author_kind}`}>
                {m.author_kind === 'customer' ? (
                  <Avatar id={ticket.customer_id} name={customer?.name ?? '?'} person="customer" />
                ) : (
                  <Avatar id={m.agent_id ?? m.id} name={author?.name ?? '?'} />
                )}
                <div className="hd-bubble">
                  <header>
                    <strong>{m.author_kind === 'customer' ? customer?.name : author?.name}</strong>
                    {m.author_kind === 'note' && (
                      <span className="hd-note-label">
                        <StickyNote size={11} />
                        {t('internalNote')}
                      </span>
                    )}
                    <time>{dateTime(m.created_at, locale)}</time>
                  </header>
                  <p>{m.body}</p>
                </div>
              </li>
            )
          })}
        </ol>
        {readOnly ? null : closed ? (
          <p className="hd-composer-closed">
            <Lock size={13} />
            {t('closedHint')}
          </p>
        ) : (
          <Composer key={ticket.id} agentId={agentId} t={t} busy={busy} onSend={(body, note) => onRun({ type: 'reply', ticketId: ticket.id, agentId: agentId!, body, note })} />
        )}
      </section>
      <CustomerSide data={data} ticket={ticket} customer={customer} agents={agents} now={now} locale={locale} t={t} onOpenTicket={onOpenTicket} />
    </>
  )
}

function Control({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="hd-control">
      <span>{label}</span>
      {children}
    </div>
  )
}

function Composer({ agentId, t, busy, onSend }: { agentId: string | null; t: T; busy: boolean; onSend: (body: string, note: boolean) => Promise<boolean> }) {
  const [mode, setMode] = useState<'reply' | 'note'>('reply')
  const [body, setBody] = useState('')
  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!body.trim() || !agentId || busy) return
    if (await onSend(body, mode === 'note')) setBody('')
  }
  return (
    <form className={`hd-composer hd-composer-${mode}`} onSubmit={send}>
      <div className="hd-composer-tabs" role="tablist">
        {(['reply', 'note'] as const).map((m) => (
          <button type="button" role="tab" key={m} aria-selected={mode === m} onClick={() => setMode(m)}>
            {m === 'reply' ? <Send size={13} /> : <StickyNote size={13} />}
            {t(m === 'reply' ? 'reply' : 'internalNote')}
          </button>
        ))}
      </div>
      <textarea
        value={body}
        maxLength={10_000}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
        }}
        placeholder={t(mode === 'reply' ? 'replyPlaceholder' : 'notePlaceholder')}
        aria-label={t(mode === 'reply' ? 'reply' : 'internalNote')}
      />
      <footer>
        <span className="hd-muted">{agentId ? t(mode === 'reply' ? 'replyHint' : 'noteHint') : t('pickAgent')}</span>
        <button type="submit" className="hd-primary" disabled={busy || !body.trim() || !agentId}>
          {mode === 'reply' ? <Send size={14} /> : <StickyNote size={14} />}
          {busy ? t('sending') : t(mode === 'reply' ? 'send' : 'addNote')}
        </button>
      </footer>
    </form>
  )
}

function CustomerSide({
  data,
  ticket,
  customer,
  agents,
  now,
  locale,
  t,
  onOpenTicket,
}: {
  data: HelpdeskData
  ticket: Ticket
  customer?: Customer
  agents: Map<string, Agent>
  now: number
  locale: Locale
  t: T
  onOpenTicket: (ticket: Ticket) => void
}) {
  const others = data.tickets
    .filter((tk) => tk.customer_id === ticket.customer_id && tk.id !== ticket.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const response = firstResponseMinutes(ticket)
  const s = slaState(ticket, now)
  const tags = ticket.tags.split(',').filter(Boolean)
  return (
    <aside className="hd-side">
      {customer && (
        <section className="hd-card hd-person">
          <Avatar id={customer.id} name={customer.name} size="lg" person="customer" />
          <div>
            <strong>{customer.name}</strong>
            <span>{customer.email}</span>
          </div>
          <dl>
            <dt>{t('company')}</dt>
            <dd>{customer.company || '—'}</dd>
            <dt>{t('plan')}</dt>
            <dd>
              <span className={`hd-plan hd-plan-${customer.plan}`}>{t(customer.plan)}</span>
            </dd>
            <dt>{t('customerSince')}</dt>
            <dd>{new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short' }).format(new Date(customer.created_at))}</dd>
          </dl>
        </section>
      )}
      <section className="hd-card">
        <h3>{t('sla')}</h3>
        <dl className="hd-sla-list">
          <dt>{t('firstResponse')}</dt>
          <dd>
            {response !== null ? (
              <span className={ticket.response_due_at && ticket.first_response_at! > ticket.response_due_at ? 'hd-bad' : 'hd-good'}>{duration(response, locale)}</span>
            ) : ticket.response_due_at ? (
              <span className={now > Date.parse(ticket.response_due_at) && isUnsolved(ticket) ? 'hd-bad' : ''}>
                {t('due')} {dateTime(ticket.response_due_at, locale)}
              </span>
            ) : (
              '—'
            )}
          </dd>
          <dt>{t('resolution')}</dt>
          <dd>
            {ticket.solved_at ? (
              <span className={ticket.due_at && ticket.solved_at > ticket.due_at ? 'hd-bad' : 'hd-good'}>
                {duration((Date.parse(ticket.solved_at) - Date.parse(ticket.created_at)) / 60_000, locale)}
              </span>
            ) : ticket.due_at ? (
              <span className={s.state === 'breached' && s.target === 'resolution' ? 'hd-bad' : ''}>
                {t('due')} {dateTime(ticket.due_at, locale)}
              </span>
            ) : (
              '—'
            )}
          </dd>
          <dt>{t('assignee')}</dt>
          <dd>{ticket.assignee_id ? agents.get(ticket.assignee_id)?.name : t('unassigned')}</dd>
        </dl>
        {tags.length > 0 && (
          <div className="hd-tags">
            {tags.map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
        )}
      </section>
      <section className="hd-card">
        <h3>
          {t('otherTickets')} <em>{others.length}</em>
        </h3>
        {others.length === 0 ? (
          <p className="hd-muted hd-small">{t('noOtherTickets')}</p>
        ) : (
          <ul className="hd-mini-tickets">
            {others.slice(0, 8).map((tk) => (
              <li key={tk.id}>
                <button onClick={() => onOpenTicket(tk)}>
                  <span className={`hd-dot hd-dot-${tk.status}`} title={t(tk.status)} />
                  <span>{tk.subject}</span>
                  <time>{ago(tk.created_at, now, locale)}</time>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}

// ── Customers ──

function CustomersPage({
  data,
  now,
  locale,
  t,
  selectedId,
  onSelect,
  onEdit,
  onNewTicket,
  onShowTicket,
}: {
  data: HelpdeskData
  now: number
  locale: Locale
  t: T
  selectedId: string | null
  onSelect: (id: string) => void
  onEdit: (customer?: Customer) => void
  onNewTicket: (customer: Customer) => void
  onShowTicket: (ticket: Ticket) => void
}) {
  const [query, setQuery] = useState('')
  const [plan, setPlan] = useState<Plan | ''>('')
  const stats = useMemo(() => {
    const map = new Map<string, { total: number; open: number; last: string | null; breached: number }>()
    for (const tk of data.tickets) {
      const s = map.get(tk.customer_id) ?? { total: 0, open: 0, last: null, breached: 0 }
      s.total++
      if (isUnsolved(tk)) s.open++
      if (!s.last || tk.last_activity_at > s.last) s.last = tk.last_activity_at
      map.set(tk.customer_id, s)
    }
    return map
  }, [data.tickets])
  const q = query.trim().toLowerCase()
  const rows = data.customers
    .filter((c) => (!plan || c.plan === plan) && `${c.name} ${c.email} ${c.company}`.toLowerCase().includes(q))
    .sort((a, b) => (stats.get(b.id)?.last ?? '').localeCompare(stats.get(a.id)?.last ?? '') || a.name.localeCompare(b.name))
  const selected = data.customers.find((c) => c.id === selectedId) ?? rows[0]
  const tickets = selected ? data.tickets.filter((tk) => tk.customer_id === selected.id).sort((a, b) => b.created_at.localeCompare(a.created_at)) : []
  return (
    <div className="hd-directory">
      <section className="hd-panel hd-directory-list">
        <div className="hd-filters">
          <label className="hd-search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchCustomers')} />
          </label>
          <Choice label={t('plan')} value={plan} onChange={(v) => setPlan(v as Plan | '')} options={[['', t('allPlans')], ...plans.map((p): [string, string] => [p, t(p)])]} />
          {!data.readOnly && (
            <button onClick={() => onEdit()}>
              <Plus size={15} />
              {t('addCustomer')}
            </button>
          )}
        </div>
        <div className="hd-table-scroll">
          <table className="hd-table">
            <thead>
              <tr>
                <th>{t('customer')}</th>
                <th>{t('plan')}</th>
                <th className="hd-num">{t('openTickets')}</th>
                <th className="hd-num">{t('allTickets')}</th>
                <th>{t('lastContact')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const s = stats.get(c.id)
                return (
                  <tr key={c.id} className={selected?.id === c.id ? 'is-selected' : ''}>
                    <td>
                      <button className="hd-person-cell" onClick={() => onSelect(c.id)}>
                        <Avatar id={c.id} name={c.name} size="sm" person="customer" />
                        <span>
                          <strong>{c.name}</strong>
                          <em>{c.company || c.email}</em>
                        </span>
                      </button>
                    </td>
                    <td>
                      <span className={`hd-plan hd-plan-${c.plan}`}>{t(c.plan)}</span>
                    </td>
                    <td className="hd-num">{s?.open ? <strong className="hd-open-count">{s.open}</strong> : <span className="hd-muted">0</span>}</td>
                    <td className="hd-num">{s?.total ?? 0}</td>
                    <td className="hd-muted">{s?.last ? ago(s.last, now, locale) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p className="hd-empty-line">{t('noCustomers')}</p>}
        </div>
      </section>
      {selected && (
        <section className="hd-panel hd-directory-detail">
          <header className="hd-profile">
            <Avatar id={selected.id} name={selected.name} size="lg" person="customer" />
            <div>
              <h2>{selected.name}</h2>
              <p>
                {selected.email}
                {selected.company && ` · ${selected.company}`}
              </p>
            </div>
            {!data.readOnly && (
              <button className="hd-icon" aria-label={t('editCustomer')} title={t('editCustomer')} onClick={() => onEdit(selected)}>
                <Pencil size={14} />
              </button>
            )}
          </header>
          <div className="hd-profile-stats">
            <Stat label={t('plan')} value={<span className={`hd-plan hd-plan-${selected.plan}`}>{t(selected.plan)}</span>} />
            <Stat label={t('openTickets')} value={String(tickets.filter(isUnsolved).length)} />
            <Stat label={t('allTickets')} value={String(tickets.length)} />
          </div>
          <div className="hd-profile-head">
            <h3>{t('tickets')}</h3>
            {!data.readOnly && (
              <button onClick={() => onNewTicket(selected)}>
                <Plus size={14} />
                {t('newTicket')}
              </button>
            )}
          </div>
          {tickets.length === 0 ? (
            <p className="hd-muted hd-small">{t('noOtherTickets')}</p>
          ) : (
            <ul className="hd-mini-tickets hd-mini-wide">
              {tickets.map((tk) => (
                <li key={tk.id}>
                  <button onClick={() => onShowTicket(tk)}>
                    <span className={`hd-dot hd-dot-${tk.status}`} title={t(tk.status)} />
                    <span>{tk.subject}</span>
                    <StatusPill status={tk.status} t={t} />
                    <time>{ago(tk.created_at, now, locale)}</time>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="hd-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

// ── Reports ──

function ReportsPage({ data, now, locale, t, onEditSla }: { data: HelpdeskData; now: number; locale: Locale; t: T; onEditSla: (policy: SlaPolicy) => void }) {
  const from = now - 30 * DAY
  const days = lastDays(localDay(now), 30)
  const volume = dailyVolume(data.tickets, days)
  const created = volume.reduce((sum, d) => sum + d.created, 0)
  const solved = volume.reduce((sum, d) => sum + d.solved, 0)
  const frt = medianFirstResponse(data.tickets, from)
  const breach = breachRate(data.tickets, now, from)
  const backlog = backlogByPriority(data.tickets)
  const open = backlog.reduce((sum, b) => sum + b.count, 0)
  const leaders = solvedByAgent(data.tickets, data.agents, from)
  const policies = priorities.map((p) => data.sla_policies.find((s) => s.priority === p)).filter((p): p is SlaPolicy => !!p)
  return (
    <div className="hd-reports">
      <section className="hd-kpis">
        <Kpi label={t('kpiCreated')} value={String(created)} hint={`${solved} ${t('solvedLower')}`} />
        <Kpi label={t('kpiFirstResponse')} value={frt === null ? '—' : duration(frt, locale)} hint={t('last30')} />
        <Kpi
          label={t('kpiBreach')}
          value={breach.rate === null ? '—' : `${Math.round(breach.rate * 100)}%`}
          hint={`${breach.breached} / ${breach.total}`}
          tone={breach.rate !== null && breach.rate > 0.2 ? 'bad' : undefined}
        />
        <Kpi label={t('kpiBacklog')} value={String(open)} hint={`${backlog[0].count} ${t('urgentLower')}`} />
      </section>
      {data.tickets.length >= READ_WINDOW && <p className="hd-window hd-window-wide">{t('ticketWindow')}</p>}
      <div className="hd-report-grid">
        <Panel title={t('volume')} className="hd-span-2">
          <VolumeChart rows={volume} locale={locale} t={t} />
        </Panel>
        <Panel title={t('backlog')}>
          <ul className="hd-bars">
            {(['new', 'open', 'pending'] as const).map((status) => {
              const count = data.tickets.filter((tk) => tk.status === status).length
              return (
                <li key={status}>
                  <span>
                    <StatusPill status={status} t={t} />
                  </span>
                  <div className="hd-bar">
                    <i className={`hd-fill-${status}`} style={{ width: `${open ? (count / open) * 100 : 0}%` }} />
                  </div>
                  <strong>{count}</strong>
                </li>
              )
            })}
          </ul>
          <hr className="hd-rule" />
          <ul className="hd-bars">
            {backlog.map((b) => (
              <li key={b.priority}>
                <span>
                  <PriorityMark priority={b.priority} t={t} always />
                </span>
                <div className="hd-bar">
                  <i className={`hd-fill-${b.priority}`} style={{ width: `${open ? Math.max(b.count ? 3 : 0, (b.count / Math.max(...backlog.map((x) => x.count))) * 100) : 0}%` }} />
                </div>
                <strong>{b.count}</strong>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={t('leaderboard')} className="hd-span-2">
          {leaders.length === 0 ? (
            <p className="hd-empty-line">{t('nothingYet')}</p>
          ) : (
            <ul className="hd-bars hd-leaders">
              {leaders.map(({ agent, solved: count }) => (
                <li key={agent.id}>
                  <span className="hd-agent-option">
                    <Avatar id={agent.id} name={agent.name} size="xs" />
                    {agent.name}
                    {!agent.active && <em className="hd-muted"> · {t('inactive')}</em>}
                  </span>
                  <div className="hd-bar">
                    <i style={{ width: `${(count / leaders[0].solved) * 100}%` }} />
                  </div>
                  <strong>{count}</strong>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={t('slaPolicies')}>
          <p className="hd-muted hd-small">{t('slaHint')}</p>
          <table className="hd-table hd-sla-table">
            <thead>
              <tr>
                <th>{t('priority')}</th>
                <th>{t('firstResponse')}</th>
                <th>{t('resolution')}</th>
                {!data.readOnly && <th aria-label={t('edit')} />}
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td>
                    <PriorityMark priority={p.priority} t={t} always />
                  </td>
                  <td>{duration(p.first_response_minutes, locale)}</td>
                  <td>{duration(p.resolution_minutes, locale)}</td>
                  {!data.readOnly && (
                    <td>
                      <button className="hd-icon" aria-label={t('edit')} onClick={() => onEditSla(p)}>
                        <Pencil size={13} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  )
}

function Panel({ title, className = '', children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section className={`hd-panel hd-report ${className}`}>
      <h2>{title}</h2>
      {children}
    </section>
  )
}
function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'bad' }) {
  return (
    <div className="hd-kpi">
      <span>{label}</span>
      <strong className={tone ? `hd-${tone}` : ''}>{value}</strong>
      {hint && <em>{hint}</em>}
    </div>
  )
}

function VolumeChart({ rows, locale, t }: { rows: ReturnType<typeof dailyVolume>; locale: Locale; t: T }) {
  const width = 720
  const height = 230
  const pad = { top: 14, right: 8, bottom: 26, left: 30 }
  const max = Math.max(4, ...rows.flatMap((r) => [r.created, r.solved]))
  const top = Math.ceil(max / 2) * 2
  const y = (v: number) => pad.top + (1 - v / top) * (height - pad.top - pad.bottom)
  const band = (width - pad.left - pad.right) / rows.length
  const bar = Math.max(4, band * 0.58)
  const x = (i: number) => pad.left + band * i + band / 2
  const line = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(r.solved).toFixed(1)}`).join(' ')
  const ticks = Array.from({ length: 3 }, (_, i) => Math.round((top / 2) * i))
  return (
    <figure className="hd-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('volume')}>
        {[...ticks, top].map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} className="hd-gridline" />
            <text x={pad.left - 8} y={y(v) + 4} textAnchor="end" className="hd-axis">
              {v}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const weekend = [0, 6].includes(new Date(r.day + 'T00:00:00Z').getUTCDay())
          return (
            <g key={r.day}>
              <rect x={x(i) - bar / 2} y={y(r.created)} width={bar} height={y(0) - y(r.created)} rx={2.5} className={weekend ? 'hd-bar-weekend' : 'hd-bar-created'}>
                <title>{`${dayLabel(r.day, locale)} · ${t('createdLower')} ${r.created} · ${t('solvedLower')} ${r.solved}`}</title>
              </rect>
              {(rows.length - 1 - i) % 5 === 0 && (
                <text x={x(i)} y={height - 7} textAnchor="middle" className="hd-axis">
                  {dayLabel(r.day, locale)}
                </text>
              )}
            </g>
          )
        })}
        <path d={line} className="hd-line" />
        {rows.map((r, i) => (
          <circle key={r.day} cx={x(i)} cy={y(r.solved)} r={2.2} className="hd-point" />
        ))}
      </svg>
      <figcaption>
        <span className="hd-key hd-key-created" />
        {t('createdKey')}
        <span className="hd-key hd-key-solved" />
        {t('solvedKey')}
      </figcaption>
    </figure>
  )
}

// ── Forms ──

function Choice({
  label,
  value,
  onChange,
  options,
  className = '',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: [string, ReactNode][]
  className?: string
}) {
  return (
    <Select value={value} onValueChange={(next) => next !== null && onChange(next as string)}>
      <SelectTrigger aria-label={label} className={`hd-select ${className}`}>
        <SelectValue>{(v) => options.find(([id]) => id === v)?.[1] ?? ''}</SelectValue>
      </SelectTrigger>
      <SelectContent className="hd-select-popup" positionerClassName="hd-select-positioner">
        {options.map(([id, text]) => (
          <SelectItem key={id || 'none'} value={id}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="hd-modal-backdrop" />
        <Dialog.Popup className="helpdesk-app hd-modal">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close className="hd-icon hd-modal-close" aria-label="Close">
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
    <label className="hd-field">
      <span>{label}</span>
      {children}
      {hint && <em>{hint}</em>}
    </label>
  )
}

function Actions({ t, busy, error, onCancel, submit }: { t: T; busy: boolean; error: string; onCancel: () => void; submit?: string }) {
  return (
    <>
      {error && <p className="hd-error">{t(error)}</p>}
      <div className="hd-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </button>
        <button type="submit" className="hd-primary" disabled={busy}>
          {busy ? t('saving') : (submit ?? t('save'))}
        </button>
      </div>
    </>
  )
}

function TicketForm({
  customers,
  active,
  initialCustomer,
  agentId,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  customers: Customer[]
  active: Agent[]
  initialCustomer?: string
  agentId: string | null
  t: T
  busy: boolean
  error: string
  onSubmit: (action: Extract<HelpdeskAction, { type: 'create-ticket' }>) => void
  onCancel: () => void
}) {
  const sorted = [...customers].sort((a, b) => a.name.localeCompare(b.name))
  const [customerId, setCustomerId] = useState(initialCustomer ?? sorted[0]?.id ?? '')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [priority, setPriority] = useState<Priority>('normal')
  const [channel, setChannel] = useState<Channel>('phone')
  const [assigneeId, setAssigneeId] = useState(agentId ?? '')
  const [tags, setTags] = useState('')
  // One id per open form, so a retry after a lost response cannot file the ticket twice.
  const [id] = useState(() => crypto.randomUUID())
  return (
    <form
      className="hd-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({ type: 'create-ticket', id, customerId, subject, body, priority, channel, assigneeId: assigneeId || null, tags })
      }}
    >
      <Field label={t('customer')}>
        <Choice label={t('customer')} value={customerId} onChange={setCustomerId} options={sorted.map((c): [string, string] => [c.id, `${c.name}${c.company ? ` · ${c.company}` : ''}`])} />
      </Field>
      <Field label={t('subject')}>
        <input required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus />
      </Field>
      <Field label={t('customerMessage')} hint={t('customerMessageHint')}>
        <textarea required rows={4} maxLength={10_000} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <div className="hd-form-row">
        <Field label={t('priority')}>
          <Choice label={t('priority')} value={priority} onChange={(v) => setPriority(v as Priority)} options={priorities.map((p): [string, string] => [p, t(p)])} />
        </Field>
        <Field label={t('channel')}>
          <Choice label={t('channel')} value={channel} onChange={(v) => setChannel(v as Channel)} options={channels.map((c): [string, string] => [c, t(c)])} />
        </Field>
      </div>
      <div className="hd-form-row">
        <Field label={t('assignee')}>
          <Choice label={t('assignee')} value={assigneeId} onChange={setAssigneeId} options={[['', t('unassigned')], ...active.map((a): [string, string] => [a.id, a.name])]} />
        </Field>
        <Field label={t('tags')} hint={t('tagsHint')}>
          <input value={tags} maxLength={200} onChange={(e) => setTags(e.target.value)} />
        </Field>
      </div>
      <Actions t={t} busy={busy} error={error} onCancel={onCancel} submit={t('createTicket')} />
    </form>
  )
}

function CustomerForm({
  customer,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  customer?: Customer
  t: T
  busy: boolean
  error: string
  onSubmit: (action: Extract<HelpdeskAction, { type: 'save-customer' }>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(customer?.name ?? '')
  const [email, setEmail] = useState(customer?.email ?? '')
  const [company, setCompany] = useState(customer?.company ?? '')
  const [plan, setPlan] = useState<Plan>(customer?.plan ?? 'free')
  return (
    <form
      className="hd-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({ type: 'save-customer', ...(customer ? { id: customer.id } : {}), name, email, company, plan })
      }}
    >
      <div className="hd-form-row">
        <Field label={t('name')}>
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label={t('email')}>
          <input required type="email" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <div className="hd-form-row">
        <Field label={t('company')}>
          <input maxLength={120} value={company} onChange={(e) => setCompany(e.target.value)} />
        </Field>
        <Field label={t('plan')}>
          <Choice label={t('plan')} value={plan} onChange={(v) => setPlan(v as Plan)} options={plans.map((p): [string, string] => [p, t(p)])} />
        </Field>
      </div>
      <Actions t={t} busy={busy} error={error} onCancel={onCancel} />
    </form>
  )
}

function SlaForm({
  policy,
  t,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  policy: SlaPolicy
  t: T
  busy: boolean
  error: string
  onSubmit: (action: Extract<HelpdeskAction, { type: 'set-sla' }>) => void
  onCancel: () => void
}) {
  const [response, setResponse] = useState(String(policy.first_response_minutes))
  const [resolution, setResolution] = useState(String(policy.resolution_minutes))
  const [local, setLocal] = useState('')
  return (
    <form
      className="hd-form"
      onSubmit={(e) => {
        e.preventDefault()
        const [r, s] = [Number(response), Number(resolution)]
        if (!/^\d+$/.test(response.trim()) || !/^\d+$/.test(resolution.trim()) || r <= 0 || s <= 0) return setLocal('invalid_minutes')
        if (s < r) return setLocal('resolution_before_response')
        setLocal('')
        onSubmit({ type: 'set-sla', priority: policy.priority, firstResponseMinutes: r, resolutionMinutes: s })
      }}
    >
      <p className="hd-muted">{t('slaFormHint')}</p>
      <div className="hd-form-row">
        <Field label={t('firstResponseMinutes')}>
          <input inputMode="numeric" value={response} onChange={(e) => setResponse(e.target.value)} autoFocus />
        </Field>
        <Field label={t('resolutionMinutes')}>
          <input inputMode="numeric" value={resolution} onChange={(e) => setResolution(e.target.value)} />
        </Field>
      </div>
      <Actions t={t} busy={busy} error={local || error} onCancel={onCancel} />
    </form>
  )
}
