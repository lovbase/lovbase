import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Menu } from '@base-ui/react/menu'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  CalendarDays,
  Columns3,
  Gauge,
  Inbox,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import {
  POINTS,
  addDays,
  applyMove,
  column,
  cycleTimes,
  dayLabel,
  dayOf,
  filterTasks,
  initials,
  isOverdue,
  lastWeeks,
  latestDay,
  localeOf,
  median,
  myWork,
  planMove,
  priorities,
  projectProgress,
  sortForList,
  statuses,
  taskKey,
  timeline,
  weeklyVelocity,
  workload,
  type DueFilter,
  type Locale,
  type Member,
  type Priority,
  type Project,
  type ProjectFields,
  type ProjectsAction,
  type ProjectsData,
  type ProjectsProps,
  type Status,
  type Task,
  type TaskEvent,
  type TaskFields,
  type WorkGroup,
} from '@lovbase/core/projects'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { errorKey, translate } from './labels'
import './projects.css'

type Page = 'board' | 'list' | 'mywork' | 'overview'
type Drawer = { mode: 'edit'; taskId: string } | { mode: 'create'; projectId: string; status: Status }
type T = (key: string) => string
type Drop = { status: Status; index: number }

const navigation: [Page, typeof Inbox][] = [
  ['board', Columns3],
  ['list', List],
  ['mywork', Inbox],
  ['overview', Gauge],
]
const DONE_SHOWN = 6
const swatches = ['#5e5ce6', '#0090ff', '#12a594', '#30a46c', '#f76b15', '#e5484d', '#d6409f', '#8e4ec6']
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const timeLabel = (iso: string, locale: Locale) =>
  new Intl.DateTimeFormat(localeOf(locale), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

export function ProjectsApp({ client, initialLocale = 'en', locale: controlledLocale, onLocaleChange, initialData }: ProjectsProps) {
  const [localLocale, setLocalLocale] = useState<Locale>(initialLocale)
  const locale = controlledLocale ?? localLocale
  const t: T = (key) => translate(locale, key)
  const [data, setData] = useState<ProjectsData | null>(initialData ?? null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(!initialData)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [page, setPage] = useState<Page>('board')
  const [projectId, setProjectId] = useState('')
  const [drawer, setDrawer] = useState<Drawer | null>(null)
  const [projectForm, setProjectForm] = useState<{ project?: Project } | null>(null)
  const [filter, setFilter] = useState({ projectId: '', assigneeId: '', priority: '' as Priority | '', status: '' as Status | '', due: '' as DueFilter, query: '' })
  const [memberId, setMemberId] = useState('')
  const [drag, setDrag] = useState<string | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const [allDone, setAllDone] = useState(false)
  const root = useRef<HTMLDivElement>(null)

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
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 3500)
    return () => clearTimeout(timer)
  }, [notice])
  const switchLocale = (next: Locale) => {
    setLocalLocale(next)
    onLocaleChange?.(next)
  }

  /** One action, one statement; then the whole board is read back, triggers' work included. */
  const run = async (action: ProjectsAction) => {
    if (busy || !data || data.readOnly) return false
    setBusy(true)
    setFormError('')
    try {
      await client.run(action)
      setData(await client.read())
      return true
    } catch (e) {
      setFormError(errorKey(e instanceof Error ? e.message : ''))
      return false
    } finally {
      setBusy(false)
    }
  }

  const view = useMemo(() => {
    if (!data) return null
    // A live board runs on the clock. The read-only demo runs on its own latest day, so a gallery
    // visitor months later still sees this week's work rather than a wall of overdue cards.
    const now = (data.readOnly && latestDay(data)) || today()
    const projects = new Map(data.projects.map((p) => [p.id, p]))
    const members = new Map(data.members.map((m) => [m.id, m]))
    const active = data.projects.filter((p) => !p.archived)
    return { now, projects, members, active, load: workload(data, now) }
  }, [data])

  const current = view ? (view.projects.get(projectId) ?? view.active[0] ?? data?.projects[0]) : undefined
  const work = view?.load.find((l) => l.member.id === memberId)?.member ?? view?.load[0]?.member

  if (!data || !view)
    return (
      <div className="projects-app pb-center">
        {error ? (
          <div>
            <p>{t(error)}</p>
            <button onClick={() => void read()}>{t('retry')}</button>
          </div>
        ) : (
          <p className="pb-muted">{loading ? t('loading') : ''}</p>
        )}
      </div>
    )

  const keyOf = (task: Task) => taskKey(view.projects.get(task.project_id), task)
  const focusCard = (id: string) =>
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-card="${id}"] .pb-card-main`)?.focus())

  /**
   * Moves a card and writes one UPDATE with a position between its new neighbours. The board
   * updates at once; the read that follows brings back what the triggers recorded.
   */
  const move = async (taskId: string, status: Status, index: number) => {
    if (data.readOnly || busy) return
    const task = data.tasks.find((x) => x.id === taskId)
    if (!task) return
    let tasks = data.tasks
    let plan = planMove(tasks, taskId, status, index)
    if (plan.unchanged) return
    setBusy(true)
    const before = data
    try {
      if (plan.position === null) {
        // Neighbours too close to split: space the column out in one statement, then place.
        await client.run({ action: 'rebalance-column', projectId: task.project_id, status })
        tasks = (await client.read()).tasks
        plan = planMove(tasks, taskId, status, index)
      }
      const position = plan.position!
      setData({ ...data, tasks: applyMove(tasks, taskId, status, position) })
      focusCard(taskId)
      await client.run({ action: 'move-task', taskId, status, position })
      setData(await client.read())
      setNotice(`${keyOf(task)} · ${t('moved')} ${t(status)}`)
    } catch (e) {
      setData(before)
      setNotice(t(errorKey(e instanceof Error ? e.message : '')))
    } finally {
      setBusy(false)
      focusCard(taskId)
    }
  }
  const nudge = (task: Task, direction: 'up' | 'down' | 'top' | 'bottom' | 'left' | 'right') => {
    const cells = column(data.tasks, task.project_id, task.status)
    const at = cells.findIndex((x) => x.id === task.id)
    const s = statuses.indexOf(task.status)
    if (direction === 'left' || direction === 'right') {
      const next = statuses[s + (direction === 'left' ? -1 : 1)]
      if (next) void move(task.id, next, Math.min(at, column(data.tasks, task.project_id, next).length))
      return
    }
    const index = { up: at - 1, down: at + 1, top: 0, bottom: cells.length - 1 }[direction]
    if (index >= 0 && index < cells.length) void move(task.id, task.status, index)
  }
  const onCardKey = (event: KeyboardEvent, task: Task) => {
    if (!event.altKey || data.readOnly) return
    const keys: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
    const direction = keys[event.key]
    if (!direction) return
    event.preventDefault()
    nudge(task, direction)
  }
  const dragOver = (event: DragEvent<HTMLElement>, status: Status) => {
    if (!drag) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-card]')].filter((el) => el.dataset.card !== drag)
    let index = cards.findIndex((el) => {
      const r = el.getBoundingClientRect()
      return event.clientY < r.top + r.height / 2
    })
    if (index < 0) index = cards.length
    if (drop?.status !== status || drop.index !== index) setDrop({ status, index })
  }
  const endDrag = () => {
    setDrag(null)
    setDrop(null)
  }
  const openTask = (task: Task) => {
    setFormError('')
    setDrawer({ mode: 'edit', taskId: task.id })
  }
  const newTask = (status: Status = 'todo', project = current) => {
    if (!project) return
    setFormError('')
    setDrawer({ mode: 'create', projectId: project.id, status })
  }

  const card = (task: Task) => {
    const assignee = task.assignee_id ? view.members.get(task.assignee_id) : undefined
    const late = isOverdue(task, view.now)
    return (
      <li
        key={task.id}
        data-card={task.id}
        className={`pb-card${drag === task.id ? ' is-dragging' : ''}${task.status === 'done' ? ' is-done' : ''}`}
        draggable={!data.readOnly}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', task.id)
          setDrag(task.id)
        }}
        onDragEnd={endDrag}
      >
        <button className="pb-card-main" onClick={() => openTask(task)} onKeyDown={(e) => onCardKey(e, task)}>
          <span className="pb-card-top">
            <span className="pb-key">{keyOf(task)}</span>
            <PriorityIcon priority={task.priority} label={t(task.priority)} />
          </span>
          <span className="pb-card-title">{task.title}</span>
          <span className="pb-card-meta">
            {task.due_on && (
              <span className={`pb-chip${late ? ' is-late' : ''}`}>
                <CalendarDays size={12} />
                {dayLabel(task.due_on, locale)}
              </span>
            )}
            {task.points !== null && <span className="pb-chip pb-points">{task.points}</span>}
            <span className="pb-grow" />
            <Avatar member={assignee} size={20} label={t('unassigned')} />
          </span>
        </button>
        {!data.readOnly && <MoveMenu task={task} t={t} onMove={(status) => void move(task.id, status, column(data.tasks, task.project_id, status).length)} onNudge={(d) => nudge(task, d)} />}
      </li>
    )
  }

  // ── Board ──
  const board = current && (
    <>
      <div className="pb-phone-projects">
        <Choice label={t('project')} value={current.id} onChange={setProjectId} options={data.projects.map((p): [string, string] => [p.id, `${p.key} · ${p.name}`])} />
      </div>
      {!data.readOnly && <p className="pb-hint">{t('dragHint')}</p>}
      <div className="pb-board" onDragEnd={endDrag}>
        {statuses.map((status) => {
          const cells = column(data.tasks, current.id, status)
          const points = cells.reduce((sum, x) => sum + (x.points ?? 0), 0)
          // Done keeps growing; the newest few are what a standup looks at.
          const shown = status === 'done' && !allDone ? cells.slice(0, DONE_SHOWN) : cells
          const others = shown.filter((x) => x.id !== drag)
          const marker = drop?.status === status ? drop.index : -1
          return (
            <section key={status} className={`pb-column${marker >= 0 ? ' is-target' : ''}`} aria-label={t(status)}>
              <header>
                <StatusIcon status={status} />
                <h2>{t(status)}</h2>
                <span className="pb-count">{cells.length}</span>
                {points > 0 && <span className="pb-column-points">{points} {t('pointsShort')}</span>}
                {!data.readOnly && !current.archived && (
                  <button className="pb-icon" aria-label={`${t('addTask')} · ${t(status)}`} title={t('addTask')} onClick={() => newTask(status)}>
                    <Plus size={15} />
                  </button>
                )}
              </header>
              <ol
                className="pb-cards"
                onDragOver={(e) => dragOver(e, status)}
                onDrop={(e) => {
                  e.preventDefault()
                  if (drag && drop) void move(drag, drop.status, drop.index)
                  endDrag()
                }}
              >
                {shown.flatMap((task) => (others.indexOf(task) === marker ? [<li key="drop" className="pb-drop" aria-hidden />, card(task)] : [card(task)]))}
                {marker === others.length && <li className="pb-drop" aria-hidden />}
                {cells.length === 0 && marker < 0 && <li className="pb-empty-column">{t('emptyColumn')}</li>}
                {cells.length > shown.length && (
                  <li>
                    <button className="pb-more" onClick={() => setAllDone(true)}>
                      {t('showMore').replace('{n}', String(cells.length - shown.length))}
                    </button>
                  </li>
                )}
              </ol>
            </section>
          )
        })}
      </div>
    </>
  )

  // ── List ──
  const listed = sortForList(filterTasks(data.tasks, filter, view.now))
  const list = (
    <Panel>
      <div className="pb-filters">
        <label className="pb-search">
          <Search size={15} />
          <input value={filter.query} onChange={(e) => setFilter({ ...filter, query: e.target.value })} placeholder={t('search')} />
        </label>
        <Choice label={t('project')} value={filter.projectId} onChange={(v) => setFilter({ ...filter, projectId: v })} options={[['', t('allProjects')], ...data.projects.map((p): [string, string] => [p.id, p.name])]} />
        <Choice
          label={t('assignee')}
          value={filter.assigneeId}
          onChange={(v) => setFilter({ ...filter, assigneeId: v })}
          options={[['', t('allAssignees')], ['none', t('unassigned')], ...data.members.map((m): [string, string] => [m.id, m.name])]}
        />
        <Choice label={t('priority')} value={filter.priority} onChange={(v) => setFilter({ ...filter, priority: v as Priority })} options={[['', t('allPriorities')], ...priorities.map((p): [string, string] => [p, t(p)])]} />
        <Choice label={t('status')} value={filter.status} onChange={(v) => setFilter({ ...filter, status: v as Status })} options={[['', t('allStatuses')], ...statuses.map((s): [string, string] => [s, t(s)])]} />
        <Choice
          label={t('due')}
          value={filter.due}
          onChange={(v) => setFilter({ ...filter, due: v as DueFilter })}
          options={[['', t('anyDue')], ['overdue', t('overdue')], ['week', t('dueThisWeek')], ['none', t('noDate')]]}
        />
      </div>
      {listed.length === 0 ? (
        <p className="pb-empty">{t('noTasks')}</p>
      ) : (
        <div className="pb-table-scroll">
          <table className="pb-table">
            <thead>
              <tr>
                <th className="pb-col-key">ID</th>
                <th>{t('title')}</th>
                <th>{t('status')}</th>
                <th>{t('priority')}</th>
                <th>{t('assignee')}</th>
                <th className="pb-num">{t('points')}</th>
                <th>{t('due')}</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((task) => {
                const project = view.projects.get(task.project_id)
                const assignee = task.assignee_id ? view.members.get(task.assignee_id) : undefined
                return (
                  <tr key={task.id} className={task.status === 'done' ? 'is-done' : ''}>
                    <td className="pb-col-key">
                      <span className="pb-key">{keyOf(task)}</span>
                    </td>
                    <td className="pb-col-title">
                      <button className="pb-row-open" onClick={() => openTask(task)}>
                        <i className="pb-dot" style={{ background: project?.color }} />
                        {task.title}
                      </button>
                    </td>
                    <td>
                      <span className="pb-inline">
                        <StatusIcon status={task.status} />
                        {t(task.status)}
                      </span>
                    </td>
                    <td>
                      <span className="pb-inline">
                        <PriorityIcon priority={task.priority} label={t(task.priority)} />
                        {t(task.priority)}
                      </span>
                    </td>
                    <td>
                      <span className="pb-inline">
                        <Avatar member={assignee} size={20} label={t('unassigned')} />
                        {assignee?.name ?? <span className="pb-muted">{t('unassigned')}</span>}
                      </span>
                    </td>
                    <td className="pb-num">{task.points ?? '—'}</td>
                    <td className={isOverdue(task, view.now) ? 'pb-late' : ''}>{task.due_on ? dayLabel(task.due_on, locale) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="pb-footnote">
        {listed.length} {t('tasksCount')}
      </p>
    </Panel>
  )

  // ── My work ──
  const queue = work ? myWork(data.tasks, work.id, view.now) : []
  const groups = new Map<WorkGroup, Task[]>()
  for (const { task, group } of queue) groups.set(group, [...(groups.get(group) ?? []), task])
  const since = addDays(view.now, -14)
  const recent = work
    ? data.tasks
        .filter((x) => x.assignee_id === work.id && x.completed_at && dayOf(x.completed_at) >= since)
        .sort((a, b) => b.completed_at!.localeCompare(a.completed_at!))
    : []
  const workLoad = view.load.find((l) => l.member.id === work?.id)
  const workRow = (task: Task) => {
    const project = view.projects.get(task.project_id)
    return (
      <li key={task.id}>
        <button className="pb-row-open pb-work-row" onClick={() => openTask(task)}>
          <StatusIcon status={task.status} />
          <span className="pb-key">{keyOf(task)}</span>
          <span className="pb-work-title">{task.title}</span>
          <span className="pb-work-project">
            <i className="pb-dot" style={{ background: project?.color }} />
            {project?.name}
          </span>
          <PriorityIcon priority={task.priority} label={t(task.priority)} />
          <span className={`pb-work-due${isOverdue(task, view.now) ? ' pb-late' : ''}`}>{task.due_on ? dayLabel(task.due_on, locale) : ''}</span>
        </button>
      </li>
    )
  }
  const mywork = work && (
    <div className="pb-grid pb-work">
      <Panel
        className="pb-span-2"
        title={t('openTasks')}
        action={<Choice label={t('member')} value={work.id} onChange={setMemberId} options={view.load.map((l): [string, string] => [l.member.id, l.member.name])} />}
      >
        {queue.length === 0 && <p className="pb-empty">{t('allClear')}</p>}
        {(['overdue', 'today', 'week', 'later', 'undated'] as WorkGroup[])
          .filter((g) => groups.has(g))
          .map((g) => (
            <section key={g} className={`pb-work-group pb-group-${g}`}>
              <h3>
                {t(g)}
                <span className="pb-count">{groups.get(g)!.length}</span>
              </h3>
              <ul className="pb-work-list">{groups.get(g)!.map(workRow)}</ul>
            </section>
          ))}
      </Panel>
      <div className="pb-stack">
        <Panel>
          <div className="pb-member-card">
            <Avatar member={work} size={44} label="" />
            <div>
              <strong>{work.name}</strong>
              <span>{work.role}</span>
            </div>
          </div>
          <div className="pb-mini-kpis">
            <Kpi label={t('openTasks')} value={String(queue.length)} />
            <Kpi label={t('openPoints')} value={String(workLoad?.points ?? 0)} />
            <Kpi label={t('overdue')} value={String(workLoad?.overdue ?? 0)} tone={workLoad?.overdue ? 'late' : undefined} />
          </div>
        </Panel>
        <Panel title={t('recentlyDone')}>
          {recent.length === 0 ? <p className="pb-empty">—</p> : <ul className="pb-work-list pb-compact">{recent.map(workRow)}</ul>}
        </Panel>
      </div>
    </div>
  )

  // ── Overview ──
  const weeks = lastWeeks(view.now, 8)
  const velocity = weeklyVelocity(data.tasks, weeks)
  const thisWeek = velocity[velocity.length - 1]
  const open = data.tasks.filter((x) => x.status !== 'done')
  const cycle = median(cycleTimes(data, weeks[0]))
  const overview = (
    <>
      <section className="pb-kpis">
        <Kpi label={t('openTasks')} value={String(open.length)} hint={`${open.reduce((s, x) => s + (x.points ?? 0), 0)} ${t('pointsShort')}`} />
        <Kpi label={t('doneThisWeek')} value={`${thisWeek.points} ${t('pointsShort')}`} hint={`${thisWeek.tasks} ${t('tasksCount')}`} tone="ok" />
        <Kpi label={t('overdue')} value={String(open.filter((x) => isOverdue(x, view.now)).length)} tone="late" hint={`${filterTasks(open, { due: 'week' }, view.now).length} ${t('dueSoon')}`} />
        <Kpi label={t('cycleTime')} value={cycle === null ? '—' : `${cycle.toFixed(1)} ${t('days')}`} hint={t('cycleHint')} />
      </section>
      <div className="pb-grid">
        <Panel title={t('velocity')} className="pb-span-2" action={<span className="pb-muted pb-small">{t('velocityHint')}</span>}>
          <VelocityChart rows={velocity} locale={locale} t={t} />
        </Panel>
        <Panel title={t('progress')}>
          <ul className="pb-progress">
            {projectProgress(data, view.now)
              .filter((p) => !p.project.archived)
              .map((p) => (
                <li key={p.project.id}>
                  <button
                    className="pb-row-open"
                    onClick={() => {
                      setProjectId(p.project.id)
                      setPage('board')
                    }}
                  >
                    <span className="pb-progress-head">
                      <i className="pb-dot" style={{ background: p.project.color }} />
                      <strong>{p.project.name}</strong>
                      <span className="pb-muted">{p.total ? Math.round((p.done / p.total) * 100) : 0}%</span>
                    </span>
                    <StatusBar counts={p.byStatus} t={t} />
                    <span className="pb-progress-foot">
                      <span>
                        {p.done}/{p.total} {t('ofTasks')} · {p.pointsDone}/{p.points} {t('pointsShort')}
                      </span>
                      {p.overdue > 0 && <span className="pb-late">{p.overdue} {t('overdue')}</span>}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </Panel>
        <Panel title={t('workload')} className="pb-span-3" action={<span className="pb-muted pb-small">{t('workloadHint')}</span>}>
          <WorkloadBars load={view.load} t={t} onPick={(id) => {
            setMemberId(id)
            setPage('mywork')
          }} />
        </Panel>
      </div>
    </>
  )

  const editing = drawer?.mode === 'edit' ? data.tasks.find((x) => x.id === drawer.taskId) : undefined
  const content = { board, list, mywork, overview }[page]
  const heading =
    page === 'board' && current ? (
      <div className="pb-title">
        <p className="pb-eyebrow">
          <i className="pb-dot" style={{ background: current.color }} />
          {current.key}
          {current.archived && <span className="pb-tag">{t('archivedNote')}</span>}
        </p>
        <h1>{current.name}</h1>
        {current.description && <p>{current.description}</p>}
      </div>
    ) : (
      <div className="pb-title">
        <h1>{t(page)}</h1>
      </div>
    )

  return (
    <div className="projects-app" ref={root}>
      <aside className="pb-sidebar">
        <div className="pb-brand">
          <span className="pb-mark" aria-hidden>
            <svg viewBox="0 0 16 16" width="16" height="16">
              <rect x="1.5" y="2" width="3.5" height="12" rx="1.2" fill="currentColor" />
              <rect x="6.25" y="2" width="3.5" height="8" rx="1.2" fill="currentColor" opacity=".7" />
              <rect x="11" y="2" width="3.5" height="5" rx="1.2" fill="currentColor" opacity=".45" />
            </svg>
          </span>
          {t('brand')}
        </div>
        <nav className="pb-nav">
          {navigation.map(([id, Icon]) => (
            <button key={id} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>
              <Icon size={16} />
              <span>{t(id)}</span>
            </button>
          ))}
        </nav>
        <div className="pb-side-projects">
          <div className="pb-side-label">
            {t('projects')}
            {!data.readOnly && (
              <button className="pb-icon" aria-label={t('newProject')} title={t('newProject')} onClick={() => {
                setFormError('')
                setProjectForm({})
              }}>
                <Plus size={14} />
              </button>
            )}
          </div>
          {[...view.active, ...data.projects.filter((p) => p.archived)].map((p) => (
            <div key={p.id} className={`pb-side-project${p.archived ? ' is-archived' : ''}`}>
              <button
                aria-current={page === 'board' && current?.id === p.id ? 'page' : undefined}
                onClick={() => {
                  setProjectId(p.id)
                  setPage('board')
                }}
              >
                <i className="pb-dot" style={{ background: p.color }} />
                <span>{p.name}</span>
                <em>{data.tasks.filter((x) => x.project_id === p.id && x.status !== 'done').length}</em>
              </button>
              {!data.readOnly && (
                <button className="pb-icon" aria-label={t('editProject')} title={t('editProject')} onClick={() => {
                  setFormError('')
                  setProjectForm({ project: p })
                }}>
                  <Pencil size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      </aside>
      <div className="pb-body">
        <header className="pb-topbar">
          {heading}
          <div className="pb-toolbar">
            <div className="pb-language" aria-label={t('language')}>
              {(['zh', 'en'] as const).map((l) => (
                <button key={l} aria-pressed={locale === l} onClick={() => switchLocale(l)}>
                  {l === 'zh' ? '中文' : 'EN'}
                </button>
              ))}
            </div>
            <button className="pb-icon" aria-label={t('refresh')} title={t('refresh')} disabled={loading} onClick={() => void read()}>
              <RefreshCw size={15} />
            </button>
            {!data.readOnly && current && !current.archived && (
              <button className="pb-primary" onClick={() => newTask()}>
                <Plus size={15} />
                <span>{t('newTask')}</span>
              </button>
            )}
          </div>
        </header>
        {data.readOnly && (
          <div className="pb-demo">
            <span className="pb-pulse" />
            {t('readonly')}
          </div>
        )}
        <main className={`pb-main pb-page-${page}`}>{content}</main>
      </div>
      <div className={`pb-notice${notice ? ' is-shown' : ''}`} role="status" aria-live="polite">
        {notice}
      </div>
      {drawer && (drawer.mode === 'create' || editing) && (
        <TaskDrawer
          key={drawer.mode === 'edit' ? drawer.taskId : 'new'}
          data={data}
          task={editing}
          projectId={drawer.mode === 'create' ? drawer.projectId : editing!.project_id}
          status={drawer.mode === 'create' ? drawer.status : editing!.status}
          defaultAuthor={work?.id ?? data.members[0]?.id ?? null}
          now={view.now}
          locale={locale}
          t={t}
          busy={busy}
          error={formError}
          onClose={() => !busy && setDrawer(null)}
          onSave={async (target, fields) => {
            const ok = editing
              ? await run({ action: 'update-task', taskId: editing.id, ...fields })
              : await run({ action: 'create-task', projectId: target, ...fields })
            if (ok && !editing) setDrawer(null)
            return ok
          }}
          onDelete={async () => {
            if (editing && (await run({ action: 'delete-task', taskId: editing.id }))) setDrawer(null)
          }}
          onComment={(authorId, body) => (editing ? run({ action: 'add-comment', taskId: editing.id, authorId, body }) : Promise.resolve(false))}
        />
      )}
      {projectForm && (
        <Modal title={t(projectForm.project ? 'editProject' : 'newProject')} onClose={() => !busy && setProjectForm(null)}>
          <ProjectForm
            project={projectForm.project}
            t={t}
            busy={busy}
            error={formError}
            onCancel={() => setProjectForm(null)}
            onSubmit={async (fields) => {
              if (await run({ action: 'save-project', ...(projectForm.project ? { id: projectForm.project.id } : {}), ...fields })) setProjectForm(null)
            }}
          />
        </Modal>
      )}
    </div>
  )
}

// ── Small pieces ──

function StatusIcon({ status }: { status: Status }) {
  const fill = { backlog: 0, todo: 0, doing: 0.5, review: 0.75, done: 1 }[status]
  // A pie that fills as work moves right, the way most trackers draw status.
  const angle = fill * 2 * Math.PI
  const x = 7 + 3.5 * Math.sin(angle)
  const y = 7 - 3.5 * Math.cos(angle)
  return (
    <svg className={`pb-status pb-status-${status}`} viewBox="0 0 14 14" width="14" height="14" aria-hidden>
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={status === 'backlog' ? '2 2' : undefined} />
      {status === 'done' ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="M4.3 7.2 6.2 9 9.8 5.2" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        fill > 0 && <path d={`M7 7 L7 3.5 A3.5 3.5 0 ${fill > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`} fill="currentColor" />
      )}
    </svg>
  )
}

function PriorityIcon({ priority, label }: { priority: Priority; label: string }) {
  if (priority === 'urgent')
    return (
      <svg className="pb-priority pb-priority-urgent" viewBox="0 0 14 14" width="14" height="14" role="img" aria-label={label}>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
        <path d="M7 3.8v4M7 10.2v.1" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  const level = { low: 1, medium: 2, high: 3 }[priority]
  return (
    <svg className="pb-priority" viewBox="0 0 14 14" width="14" height="14" role="img" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={1.5 + i * 4} y={9 - i * 3} width="3" height={4 + i * 3} rx="1" fill="currentColor" opacity={i < level ? 1 : 0.22} />
      ))}
    </svg>
  )
}

function Avatar({ member, size, label }: { member?: Member; size: number; label: string }) {
  return member ? (
    <span className="pb-avatar" style={{ width: size, height: size, background: member.color, fontSize: size * 0.42 }} title={member.name}>
      {initials(member.name)}
    </span>
  ) : (
    <span className="pb-avatar is-empty" style={{ width: size, height: size }} title={label} role="img" aria-label={label} />
  )
}

function StatusBar({ counts, t }: { counts: Record<Status, number>; t: T }) {
  const total = statuses.reduce((s, x) => s + counts[x], 0) || 1
  return (
    <span className="pb-statusbar" role="img" aria-label={statuses.map((s) => `${t(s)} ${counts[s]}`).join(', ')}>
      {[...statuses].reverse().map((s) =>
        counts[s] ? <i key={s} className={`pb-seg-${s}`} style={{ width: `${(counts[s] / total) * 100}%` }} title={`${t(s)} · ${counts[s]}`} /> : null,
      )}
    </span>
  )
}

function Panel({ title, action, className = '', children }: { title?: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`pb-panel ${className}`}>
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

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'ok' | 'late' }) {
  return (
    <div className="pb-kpi">
      <span>{label}</span>
      <strong className={tone ? `pb-tone-${tone}` : ''}>{value}</strong>
      {hint && <em>{hint}</em>}
    </div>
  )
}

function MoveMenu({ task, t, onMove, onNudge }: { task: Task; t: T; onMove: (status: Status) => void; onNudge: (d: 'up' | 'down' | 'top' | 'bottom') => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger className="pb-icon pb-card-menu" aria-label={`${t('move')} · ${task.title}`}>
        <MoreHorizontal size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="pb-menu-positioner" sideOffset={4} align="end">
          <Menu.Popup className="pb-menu">
            <Menu.Group>
              <Menu.GroupLabel className="pb-menu-label">{t('moveTo')}</Menu.GroupLabel>
              {statuses
                .filter((s) => s !== task.status)
                .map((s) => (
                  <Menu.Item key={s} className="pb-menu-item" onClick={() => onMove(s)}>
                    <StatusIcon status={s} />
                    {t(s)}
                  </Menu.Item>
                ))}
            </Menu.Group>
            <Menu.Separator className="pb-menu-separator" />
            {(
              [
                ['top', ArrowUpToLine, 'moveTop'],
                ['up', ArrowUp, 'moveUp'],
                ['down', ArrowDown, 'moveDown'],
                ['bottom', ArrowDownToLine, 'moveBottom'],
              ] as const
            ).map(([d, Icon, label]) => (
              <Menu.Item key={d} className="pb-menu-item" onClick={() => onNudge(d)}>
                <Icon size={14} />
                {t(label)}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function niceStep(raw: number) {
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1)))
  return [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? power * 10
}

function VelocityChart({ rows, locale, t }: { rows: ReturnType<typeof weeklyVelocity>; locale: Locale; t: T }) {
  const width = 640
  const height = 230
  const pad = { top: 22, right: 8, bottom: 28, left: 34 }
  const max = Math.max(4, ...rows.map((r) => r.points))
  const step = niceStep(max / 4)
  const top = Math.ceil(max / step) * step
  const y = (v: number) => pad.top + (1 - v / top) * (height - pad.top - pad.bottom)
  const band = (width - pad.left - pad.right) / rows.length
  const bar = Math.min(34, band * 0.56)
  // The current week is still running; it is drawn lighter and left out of the average.
  const full = rows.slice(0, -1)
  const average = full.length ? full.reduce((s, r) => s + r.points, 0) / full.length : 0
  return (
    <figure className="pb-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('velocity')}>
        {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} className="pb-gridline" />
            <text x={pad.left - 8} y={y(v) + 4} textAnchor="end" className="pb-axis">
              {v}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = pad.left + band * i + band / 2
          const last = i === rows.length - 1
          return (
            <g key={r.week}>
              <rect x={x - bar / 2} y={y(r.points)} width={bar} height={Math.max(0, y(0) - y(r.points))} rx={4} className={last ? 'pb-bar is-current' : 'pb-bar'}>
                <title>{`${dayLabel(r.week, locale)} · ${r.points} ${t('pointsShort')} · ${r.tasks} ${t('tasksCount')}`}</title>
              </rect>
              <text x={x} y={y(r.points) - 6} textAnchor="middle" className="pb-bar-label">
                {r.points}
              </text>
              <text x={x} y={height - 8} textAnchor="middle" className={`pb-axis${last ? ' is-current' : ''}`}>
                {dayLabel(r.week, locale)}
              </text>
            </g>
          )
        })}
        {average > 0 && <line x1={pad.left} x2={width - pad.right} y1={y(average)} y2={y(average)} className="pb-average" />}
      </svg>
      <figcaption>
        <span className="pb-key-bar" />
        {t('completed')}
        <span className="pb-key-bar is-current" />
        {t('thisWeek')}
        <span className="pb-key-line" />
        {t('average')} {average.toFixed(1)} {t('pointsShort')}
      </figcaption>
    </figure>
  )
}

function WorkloadBars({ load, t, onPick }: { load: ReturnType<typeof workload>; t: T; onPick: (memberId: string) => void }) {
  const max = Math.max(1, ...load.map((l) => l.todo + l.doing + l.review))
  return (
    <ul className="pb-workload">
      {load.map((l) => {
        const count = l.todo + l.doing + l.review
        return (
          <li key={l.member.id}>
            <button className="pb-row-open" onClick={() => onPick(l.member.id)}>
              <Avatar member={l.member} size={26} label="" />
              <span className="pb-workload-name">
                <strong>{l.member.name}</strong>
                <span>{l.member.role}</span>
              </span>
              <span className="pb-workload-bar" role="img" aria-label={`${t('todo')} ${l.todo}, ${t('doing')} ${l.doing}, ${t('review')} ${l.review}`}>
                {(['doing', 'review', 'todo'] as const).map((s) =>
                  l[s] ? <i key={s} className={`pb-seg-${s}`} style={{ width: `${(l[s] / max) * 100}%` }} title={`${t(s)} · ${l[s]}`} /> : null,
                )}
              </span>
              <span className="pb-workload-figures">
                <strong>{count}</strong> · {l.points} {t('pointsShort')}
                {l.overdue > 0 && <span className="pb-late"> · {l.overdue} {t('overdue')}</span>}
              </span>
            </button>
          </li>
        )
      })}
      <li className="pb-legend">
        {(['doing', 'review', 'todo'] as const).map((s) => (
          <span key={s}>
            <i className={`pb-seg-${s}`} />
            {t(s)}
          </span>
        ))}
      </li>
    </ul>
  )
}

function Choice({ label, value, onChange, options, disabled }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; disabled?: boolean }) {
  return (
    <Select value={value} onValueChange={(next) => next !== null && onChange(next as string)} disabled={disabled}>
      <SelectTrigger aria-label={label} className="pb-select">
        <SelectValue>{(v) => options.find(([id]) => id === v)?.[1] ?? ''}</SelectValue>
      </SelectTrigger>
      <SelectContent className="pb-select-popup" positionerClassName="pb-select-positioner">
        {options.map(([id, text]) => (
          <SelectItem key={id || 'all'} value={id}>
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
        <Dialog.Backdrop className="pb-backdrop" />
        <Dialog.Popup className="projects-app pb-modal">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close className="pb-icon pb-modal-close" aria-label="Close">
            <X size={17} />
          </Dialog.Close>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="pb-field">
      <span>{label}</span>
      {children}
      {hint && <em>{hint}</em>}
    </label>
  )
}

const fieldsOf = (task: Task | undefined, status: Status): TaskFields => ({
  title: task?.title ?? '',
  description: task?.description ?? '',
  status: task?.status ?? status,
  priority: task?.priority ?? 'medium',
  assigneeId: task?.assignee_id ?? null,
  points: task?.points ?? null,
  dueOn: task?.due_on ?? null,
})

/** The task editor: a drawer for an existing task (with its activity), a form for a new one. */
function TaskDrawer({
  data,
  task,
  projectId: initialProject,
  status,
  defaultAuthor,
  now,
  locale,
  t,
  busy,
  error,
  onClose,
  onSave,
  onDelete,
  onComment,
}: {
  data: ProjectsData
  task?: Task
  projectId: string
  status: Status
  defaultAuthor: string | null
  now: string
  locale: Locale
  t: T
  busy: boolean
  error: string
  onClose: () => void
  onSave: (projectId: string, fields: TaskFields) => Promise<boolean>
  onDelete: () => Promise<void>
  onComment: (authorId: string | null, body: string) => Promise<boolean>
}) {
  const readOnly = data.readOnly
  const [fields, setFields] = useState(() => fieldsOf(task, status))
  const [projectId, setProjectId] = useState(initialProject)
  const [confirming, setConfirming] = useState(false)
  const [author, setAuthor] = useState(defaultAuthor)
  const [body, setBody] = useState('')
  // After a save the drawer shows what the database now holds, including trigger-set columns.
  const saved = JSON.stringify(fieldsOf(task, status))
  useEffect(() => setFields(JSON.parse(saved) as TaskFields), [saved])
  const dirty = !task || saved !== JSON.stringify(fields)
  const project = data.projects.find((p) => p.id === projectId)
  const members = new Map(data.members.map((m) => [m.id, m]))
  const set = <K extends keyof TaskFields>(key: K, value: TaskFields[K]) => setFields((f) => ({ ...f, [key]: value }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void onSave(projectId, fields)
  }
  const describe = (e: TaskEvent) => {
    const who = (id: string | null) => (id ? (members.get(id)?.name ?? t('someone')) : t('unassigned'))
    if (e.kind === 'created') return locale === 'zh' ? `创建于「${t(e.to_value ?? '')}」` : `Created in ${t(e.to_value ?? '')}`
    if (e.kind === 'status')
      return locale === 'zh' ? `状态 ${t(e.from_value ?? '')} → ${t(e.to_value ?? '')}` : `Moved from ${t(e.from_value ?? '')} to ${t(e.to_value ?? '')}`
    if (!e.from_value) return locale === 'zh' ? `分配给 ${who(e.to_value)}` : `Assigned to ${who(e.to_value)}`
    if (!e.to_value) return locale === 'zh' ? `取消分配 ${who(e.from_value)}` : `Unassigned ${who(e.from_value)}`
    return locale === 'zh' ? `负责人 ${who(e.from_value)} → ${who(e.to_value)}` : `Reassigned from ${who(e.from_value)} to ${who(e.to_value)}`
  }
  const late = task && isOverdue(task, now)
  const memberOptions: [string, string][] = [['', t('unassigned')], ...data.members.map((m): [string, string] => [m.id, m.name])]
  const property = (label: string, control: ReactNode, value: ReactNode) => (
    <div className="pb-prop">
      <span>{label}</span>
      {readOnly ? <div className="pb-prop-value">{value}</div> : control}
    </div>
  )
  const assignee = fields.assigneeId ? members.get(fields.assigneeId) : undefined
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="pb-backdrop pb-drawer-backdrop" />
        <Dialog.Popup className="projects-app pb-drawer">
          <form onSubmit={submit} className="pb-drawer-form">
            <header className="pb-drawer-head">
              <span className="pb-eyebrow">
                <i className="pb-dot" style={{ background: project?.color }} />
                {project?.name}
                {task ? <span className="pb-key">{taskKey(project, task)}</span> : <span className="pb-muted">· {t('newTask')}</span>}
              </span>
              <Dialog.Close className="pb-icon" aria-label={t('close')} type="button">
                <X size={17} />
              </Dialog.Close>
            </header>
            <div className="pb-drawer-scroll">
              <Dialog.Title className="pb-visually-hidden">{task ? taskKey(project, task) : t('newTask')}</Dialog.Title>
              {readOnly ? (
                <>
                  <h2 className="pb-drawer-title">{fields.title}</h2>
                  {fields.description && <p className="pb-drawer-description">{fields.description}</p>}
                </>
              ) : (
                <>
                  <textarea
                    className="pb-title-input"
                    rows={1}
                    aria-label={t('title')}
                    placeholder={t('title')}
                    maxLength={200}
                    required
                    autoFocus={!task}
                    value={fields.title}
                    onChange={(e) => set('title', e.target.value.replace(/\n/g, ' '))}
                  />
                  <textarea
                    className="pb-description-input"
                    rows={4}
                    aria-label={t('description')}
                    placeholder={t('descriptionHint')}
                    maxLength={4000}
                    value={fields.description}
                    onChange={(e) => set('description', e.target.value)}
                  />
                </>
              )}
              <div className="pb-props">
                {!task &&
                  property(
                    t('project'),
                    <Choice label={t('project')} value={projectId} onChange={setProjectId} options={data.projects.filter((p) => !p.archived).map((p): [string, string] => [p.id, p.name])} />,
                    project?.name,
                  )}
                {property(
                  t('status'),
                  <Choice label={t('status')} value={fields.status} onChange={(v) => set('status', v as Status)} options={statuses.map((s): [string, string] => [s, t(s)])} />,
                  <span className="pb-inline">
                    <StatusIcon status={fields.status} />
                    {t(fields.status)}
                  </span>,
                )}
                {property(
                  t('priority'),
                  <Choice label={t('priority')} value={fields.priority} onChange={(v) => set('priority', v as Priority)} options={priorities.map((p): [string, string] => [p, t(p)])} />,
                  <span className="pb-inline">
                    <PriorityIcon priority={fields.priority} label={t(fields.priority)} />
                    {t(fields.priority)}
                  </span>,
                )}
                {property(
                  t('assignee'),
                  <Choice label={t('assignee')} value={fields.assigneeId ?? ''} onChange={(v) => set('assigneeId', v || null)} options={memberOptions} />,
                  <span className="pb-inline">
                    <Avatar member={assignee} size={20} label={t('unassigned')} />
                    {assignee?.name ?? t('unassigned')}
                  </span>,
                )}
                {property(
                  t('points'),
                  <Choice
                    label={t('points')}
                    value={fields.points === null ? '' : String(fields.points)}
                    onChange={(v) => set('points', v === '' ? null : Number(v))}
                    options={[['', t('noEstimate')], ...POINTS.map((p): [string, string] => [String(p), String(p)])]}
                  />,
                  fields.points ?? t('noEstimate'),
                )}
                {property(
                  t('dueDate'),
                  <input type="date" className="pb-date" aria-label={t('dueDate')} value={fields.dueOn ?? ''} onChange={(e) => set('dueOn', e.target.value || null)} />,
                  <span className={late ? 'pb-late' : ''}>{fields.dueOn ? dayLabel(fields.dueOn, locale, true) : t('noDate')}</span>,
                )}
              </div>
              {!readOnly && (
                <div className="pb-drawer-actions">
                  {error && <p className="pb-error">{t(error)}</p>}
                  {task &&
                    (confirming ? (
                      <span className="pb-confirm">
                        <span>{t('deleteConfirm')}</span>
                        <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
                          {t('cancel')}
                        </button>
                        <button type="button" className="pb-danger" onClick={() => void onDelete()} disabled={busy}>
                          {t('confirmDelete')}
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="pb-icon pb-delete" onClick={() => setConfirming(true)} aria-label={t('deleteTask')} title={t('deleteTask')}>
                        <Trash2 size={15} />
                      </button>
                    ))}
                  <span className="pb-grow" />
                  {!confirming && (
                    <button type="submit" className="pb-primary" disabled={busy || !dirty || !fields.title.trim()}>
                      {busy ? t('saving') : task ? t('saveChanges') : t('createTask')}
                    </button>
                  )}
                </div>
              )}
              {task && (
                <section className="pb-activity">
                  <h3>{t('activity')}</h3>
                  <ol>
                    {timeline(data, task.id).map((entry) =>
                      entry.event ? (
                        <li key={entry.event.id} className="pb-event">
                          <span className="pb-event-icon">
                            {entry.event.kind === 'status' ? (
                              <StatusIcon status={entry.event.to_value as Status} />
                            ) : entry.event.kind === 'assignee' ? (
                              <Avatar member={entry.event.to_value ? members.get(entry.event.to_value) : undefined} size={14} label="" />
                            ) : (
                              <Plus size={12} />
                            )}
                          </span>
                          <span>{describe(entry.event)}</span>
                          <time>{timeLabel(entry.at, locale)}</time>
                        </li>
                      ) : (
                        <li key={entry.comment!.id} className="pb-comment">
                          <Avatar member={entry.comment!.author_id ? members.get(entry.comment!.author_id) : undefined} size={24} label="" />
                          <div>
                            <p className="pb-comment-head">
                              <strong>{entry.comment!.author_id ? (members.get(entry.comment!.author_id)?.name ?? t('someone')) : t('someone')}</strong>
                              <time>{timeLabel(entry.at, locale)}</time>
                            </p>
                            <p>{entry.comment!.body}</p>
                          </div>
                        </li>
                      ),
                    )}
                  </ol>
                </section>
              )}
            </div>
          </form>
          {task && !readOnly && (
            <form
              className="pb-composer"
              onSubmit={async (e) => {
                e.preventDefault()
                if (body.trim() && (await onComment(author, body))) setBody('')
              }}
            >
              <textarea rows={2} aria-label={t('comment')} placeholder={t('commentHint')} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
              <div className="pb-composer-row">
                <Choice label={t('commentAs')} value={author ?? ''} onChange={(v) => setAuthor(v || null)} options={data.members.map((m): [string, string] => [m.id, m.name])} />
                <button type="submit" className="pb-primary" disabled={busy || !body.trim()}>
                  {t('comment')}
                </button>
              </div>
            </form>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ProjectForm({ project, t, busy, error, onSubmit, onCancel }: { project?: Project; t: T; busy: boolean; error: string; onSubmit: (fields: ProjectFields) => void; onCancel: () => void }) {
  const [name, setName] = useState(project?.name ?? '')
  const [key, setKey] = useState(project?.key ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [color, setColor] = useState(project?.color ?? swatches[0])
  const [archived, setArchived] = useState(project?.archived ?? false)
  return (
    <form
      className="pb-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({ name, key, description, color, archived })
      }}
    >
      <div className="pb-form-row">
        <Field label={t('name')}>
          <input required maxLength={80} value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('key')} hint={t('keyHint')}>
          <input required maxLength={6} value={key} onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
        </Field>
      </div>
      <Field label={t('description')}>
        <input maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="pb-field">
        <span>{t('color')}</span>
        <div className="pb-swatches" role="radiogroup" aria-label={t('color')}>
          {swatches.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
      </div>
      {project && (
        <label className="pb-check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          {t('archive')}
        </label>
      )}
      {error && <p className="pb-error">{t(error)}</p>}
      <div className="pb-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </button>
        <button type="submit" className="pb-primary" disabled={busy}>
          {busy ? t('saving') : t('save')}
        </button>
      </div>
    </form>
  )
}
