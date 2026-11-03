export type Locale = 'zh' | 'en'
export type Status = 'backlog' | 'todo' | 'doing' | 'review' | 'done'
export type Priority = 'low' | 'medium' | 'high' | 'urgent'
export type EventKind = 'created' | 'status' | 'assignee'
/** Board order, left to right. */
export const statuses: Status[] = ['backlog', 'todo', 'doing', 'review', 'done']
export const priorities: Priority[] = ['urgent', 'high', 'medium', 'low']
/** Estimates are a Fibonacci scale; the database rejects anything else. */
export const POINTS = [0, 1, 2, 3, 5, 8, 13] as const
export const projectsTables = ['members', 'projects', 'tasks', 'comments', 'task_events'] as const
/** Gap left between neighbours when a task is placed at either end of a column. */
export const POSITION_STEP = 1024
export const MAX_TITLE = 200
export const MAX_BODY = 4000

type RecordBase = { id: string; created_at: string }
export type Member = RecordBase & { name: string; role: string; color: string }
export type Project = RecordBase & {
  name: string
  /** Short uppercase prefix of every task identifier in the project, e.g. WEB in WEB-12. */
  key: string
  description: string
  color: string
  archived: boolean
}
export type Task = RecordBase & {
  project_id: string
  /** Assigned by the database, one sequence per project. */
  number: number
  title: string
  description: string
  status: Status
  priority: Priority
  assignee_id: string | null
  points: number | null
  /** A calendar day, YYYY-MM-DD. */
  due_on: string | null
  /** Order within a status column, ascending. Fractional, so a move rewrites one row. */
  position: number
  /** Set by the database when the task enters done, cleared when it leaves. */
  completed_at: string | null
}
export type Comment = RecordBase & { task_id: string; author_id: string | null; body: string }
/** Written only by database triggers. For assignee events the values are member ids. */
export type TaskEvent = RecordBase & {
  task_id: string
  kind: EventKind
  from_value: string | null
  to_value: string | null
  at: string
}
export type ProjectsData = {
  readOnly: boolean
  members: Member[]
  projects: Project[]
  tasks: Task[]
  comments: Comment[]
  task_events: TaskEvent[]
}

export type TaskFields = {
  title: string
  description: string
  status: Status
  priority: Priority
  assigneeId: string | null
  points: number | null
  dueOn: string | null
}
export type ProjectFields = { name: string; key: string; description: string; color: string; archived: boolean }
export type ProjectsAction =
  | ({ action: 'create-task'; projectId: string } & TaskFields)
  | ({ action: 'update-task'; taskId: string } & TaskFields)
  | { action: 'move-task'; taskId: string; status: Status; position: number }
  | { action: 'rebalance-column'; projectId: string; status: Status }
  | { action: 'delete-task'; taskId: string }
  | { action: 'add-comment'; taskId: string; authorId: string | null; body: string }
  | ({ action: 'save-project'; id?: string } & ProjectFields)

/**
 * The same shape as DataTemplateClient and DataTemplateProps in template-data.ts. Spelled out
 * here because this file ships on its own, as src/domain.ts, in every copy of the template.
 */
export type ProjectsClient = {
  read(): Promise<ProjectsData>
  run(action: ProjectsAction): Promise<void>
}
export type ProjectsProps = {
  client: ProjectsClient
  initialData?: ProjectsData
  initialLocale?: Locale
  locale?: Locale
  onLocaleChange?: (locale: Locale) => void
}

export const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().startsWith(value)
export const isColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value)
export const isKey = (value: string) => /^[A-Z][A-Z0-9]{1,5}$/.test(value)
export const taskKey = (project: Pick<Project, 'key'> | undefined, task: Pick<Task, 'number'>) =>
  `${project?.key ?? '?'}-${task.number}`

// ── Days and weeks. Calendar days are strings; weeks start on Monday, in UTC. ──

export const dayOf = (iso: string) => new Date(iso).toISOString().slice(0, 10)
export function addDays(day: string, days: number) {
  const d = new Date(day + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000)
}
export function weekStart(day: string) {
  const weekday = (new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7
  return addDays(day, -weekday)
}
/** The Mondays of the last `count` weeks, oldest first, ending with the week of `today`. */
export function lastWeeks(today: string, count: number) {
  const current = weekStart(today)
  return Array.from({ length: count }, (_, i) => addDays(current, (i - count + 1) * 7))
}

// ── Ordering ──

const priorityRank = (p: Priority) => priorities.indexOf(p)
const byPosition = (a: Task, b: Task) => a.position - b.position || a.number - b.number

/** The tasks of one board column, top to bottom. */
export function column(tasks: Task[], projectId: string, status: Status) {
  return tasks.filter((t) => t.project_id === projectId && t.status === status).sort(byPosition)
}

/**
 * A position strictly between two neighbours; `null` stands for the top or bottom of a column.
 * Returns null when the two are too close for a double to split, and the column needs spacing out.
 */
export function positionBetween(before: number | null, after: number | null): number | null {
  if (before === null && after === null) return POSITION_STEP
  if (before === null) return after! - POSITION_STEP
  if (after === null) return before + POSITION_STEP
  const middle = before + (after - before) / 2
  return middle > before && middle < after ? middle : null
}

/**
 * Where a task lands when dropped into `status` at `index` (counted without the task itself).
 * `position` is null when the neighbours are too close and the column must be rebalanced first.
 */
export function planMove(tasks: Task[], taskId: string, status: Status, index: number) {
  const task = tasks.find((t) => t.id === taskId)
  if (!task) throw new Error('record_unavailable')
  const others = column(tasks, task.project_id, status).filter((t) => t.id !== taskId)
  const at = Math.max(0, Math.min(index, others.length))
  const before = others[at - 1] ?? null
  const after = others[at] ?? null
  const unchanged = task.status === status && (before ? before.position < task.position : true) &&
    (after ? task.position < after.position : true)
  return {
    position: unchanged ? task.position : positionBetween(before?.position ?? null, after?.position ?? null),
    unchanged,
  }
}

/** Applies a move locally, so the board does not wait on the round trip. */
export function applyMove(tasks: Task[], taskId: string, status: Status, position: number): Task[] {
  return tasks.map((t) =>
    t.id === taskId
      ? {
          ...t,
          status,
          position,
          completed_at: status === 'done' ? (t.status === 'done' ? t.completed_at : new Date().toISOString()) : null,
        }
      : t,
  )
}

// ── Due dates, filters and personal queues ──

export const isOverdue = (task: Pick<Task, 'due_on' | 'status'>, today: string) =>
  !!task.due_on && task.status !== 'done' && task.due_on < today

export type DueFilter = '' | 'overdue' | 'week' | 'none'
export type TaskFilter = {
  projectId?: string
  assigneeId?: string
  priority?: Priority | ''
  status?: Status | ''
  due?: DueFilter
  query?: string
}
/** `assigneeId` is a member id, or 'none' for unassigned tasks. */
export function filterTasks(tasks: Task[], filter: TaskFilter, today: string) {
  const query = filter.query?.trim().toLowerCase() ?? ''
  const weekEnd = addDays(today, 7)
  return tasks.filter(
    (t) =>
      (!filter.projectId || t.project_id === filter.projectId) &&
      (!filter.assigneeId || (filter.assigneeId === 'none' ? !t.assignee_id : t.assignee_id === filter.assigneeId)) &&
      (!filter.priority || t.priority === filter.priority) &&
      (!filter.status || t.status === filter.status) &&
      (!filter.due ||
        (filter.due === 'overdue'
          ? isOverdue(t, today)
          : filter.due === 'none'
            ? !t.due_on
            : !!t.due_on && t.status !== 'done' && t.due_on >= today && t.due_on <= weekEnd)) &&
      (!query || `${t.title} ${t.description}`.toLowerCase().includes(query)),
  )
}

/** Board order across columns: by status, then the order people arranged within each column. */
export const sortForList = (tasks: Task[]) =>
  [...tasks].sort((a, b) => statuses.indexOf(a.status) - statuses.indexOf(b.status) || byPosition(a, b))

export type WorkGroup = 'overdue' | 'today' | 'week' | 'later' | 'undated'
/**
 * One member's open tasks, most pressing first: overdue (oldest due first), then by due date,
 * then undated ones by priority. Backlog is excluded: it is not anyone's work yet.
 */
export function myWork(tasks: Task[], memberId: string, today: string) {
  const weekEnd = addDays(today, 7)
  const groupOf = (t: Task): WorkGroup =>
    !t.due_on
      ? 'undated'
      : t.due_on < today
        ? 'overdue'
        : t.due_on === today
          ? 'today'
          : t.due_on <= weekEnd
            ? 'week'
            : 'later'
  const order: WorkGroup[] = ['overdue', 'today', 'week', 'later', 'undated']
  return tasks
    .filter((t) => t.assignee_id === memberId && t.status !== 'done' && t.status !== 'backlog')
    .map((task) => ({ task, group: groupOf(task) }))
    .sort(
      (a, b) =>
        order.indexOf(a.group) - order.indexOf(b.group) ||
        (a.task.due_on ?? '').localeCompare(b.task.due_on ?? '') ||
        priorityRank(a.task.priority) - priorityRank(b.task.priority) ||
        a.task.number - b.task.number,
    )
}

// ── Reports ──

/** Points and tasks completed in each week, by completed_at. Unestimated tasks count as 0 points. */
export function weeklyVelocity(tasks: Task[], weeks: string[]) {
  const rows = new Map(weeks.map((week) => [week, { week, points: 0, tasks: 0 }]))
  for (const t of tasks) {
    if (t.status !== 'done' || !t.completed_at) continue
    const row = rows.get(weekStart(dayOf(t.completed_at)))
    if (!row) continue
    row.points += t.points ?? 0
    row.tasks += 1
  }
  return [...rows.values()]
}

export type Progress = {
  project: Project
  total: number
  done: number
  points: number
  pointsDone: number
  overdue: number
  byStatus: Record<Status, number>
}
export function projectProgress(data: Pick<ProjectsData, 'projects' | 'tasks'>, today: string): Progress[] {
  return data.projects.map((project) => {
    const tasks = data.tasks.filter((t) => t.project_id === project.id)
    const byStatus = Object.fromEntries(statuses.map((s) => [s, 0])) as Record<Status, number>
    for (const t of tasks) byStatus[t.status] += 1
    return {
      project,
      total: tasks.length,
      done: byStatus.done,
      points: tasks.reduce((sum, t) => sum + (t.points ?? 0), 0),
      pointsDone: tasks.filter((t) => t.status === 'done').reduce((sum, t) => sum + (t.points ?? 0), 0),
      overdue: tasks.filter((t) => isOverdue(t, today)).length,
      byStatus,
    }
  })
}

export type Load = { member: Member; todo: number; doing: number; review: number; points: number; overdue: number }
/** Open, committed work per member (backlog excluded), heaviest first. */
export function workload(data: Pick<ProjectsData, 'members' | 'tasks'>, today: string): Load[] {
  return data.members
    .map((member) => {
      const mine = data.tasks.filter((t) => t.assignee_id === member.id && t.status !== 'done' && t.status !== 'backlog')
      return {
        member,
        todo: mine.filter((t) => t.status === 'todo').length,
        doing: mine.filter((t) => t.status === 'doing').length,
        review: mine.filter((t) => t.status === 'review').length,
        points: mine.reduce((sum, t) => sum + (t.points ?? 0), 0),
        overdue: mine.filter((t) => isOverdue(t, today)).length,
      }
    })
    .sort((a, b) => b.points - a.points || b.doing - a.doing || a.member.name.localeCompare(b.member.name))
}

/**
 * Days from first starting work (entering doing) to the last time the task entered done, for tasks
 * completed on or after `since`. Read from the trigger-written history, not from anything the UI keeps.
 */
export function cycleTimes(data: Pick<ProjectsData, 'tasks' | 'task_events'>, since: string) {
  const started = new Map<string, string>()
  for (const e of data.task_events)
    if (e.kind === 'status' && e.to_value === 'doing') {
      const prior = started.get(e.task_id)
      if (!prior || e.at < prior) started.set(e.task_id, e.at)
    }
  return data.tasks
    .filter((t) => t.status === 'done' && t.completed_at && dayOf(t.completed_at) >= since && started.has(t.id))
    .map((t) => (Date.parse(t.completed_at!) - Date.parse(started.get(t.id)!)) / 86_400_000)
}
export function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const eventKinds: EventKind[] = ['created', 'status', 'assignee']
/**
 * Events of one statement share its transaction time, so ties break the way the trigger wrote
 * them: creation, then status, then assignee.
 */
export const byEventTime = (a: Pick<TaskEvent, 'at' | 'kind'>, b: Pick<TaskEvent, 'at' | 'kind'>) =>
  a.at.localeCompare(b.at) || eventKinds.indexOf(a.kind) - eventKinds.indexOf(b.kind)

/** A task's history, oldest first: trigger-written events and comments on one timeline. */
export function timeline(data: Pick<ProjectsData, 'comments' | 'task_events'>, taskId: string) {
  return [
    ...data.task_events
      .filter((e) => e.task_id === taskId)
      .sort(byEventTime)
      .map((event) => ({ at: event.at, event, comment: null })),
    ...data.comments.filter((c) => c.task_id === taskId).map((comment) => ({ at: comment.created_at, event: null, comment })),
  ].sort((a, b) => a.at.localeCompare(b.at) || (a.event && b.event ? byEventTime(a.event, b.event) : a.event ? -1 : 1))
}

/**
 * The newest day anything happened. A live board measures "today" by the clock; a read-only demo
 * measures it from its own history, so its overdue counts and weekly chart do not age.
 */
export function latestDay(data: Pick<ProjectsData, 'task_events' | 'comments'>) {
  let latest = ''
  for (const e of data.task_events) if (e.at > latest) latest = e.at
  for (const c of data.comments) if (c.created_at > latest) latest = c.created_at
  return latest ? dayOf(latest) : null
}

// ── Writes. Each action is one statement through the SQL API; triggers do the rest. ──

export type Statement = { sql: string; params: unknown[] }

export function checkTask(fields: TaskFields) {
  const title = fields.title.trim()
  if (!title || title.length > MAX_TITLE) throw new Error('invalid_title')
  if (!statuses.includes(fields.status) || !priorities.includes(fields.priority)) throw new Error('invalid_input')
  if (fields.points !== null && !(POINTS as readonly number[]).includes(fields.points)) throw new Error('invalid_points')
  if (fields.dueOn !== null && !isDay(fields.dueOn)) throw new Error('invalid_date')
  if (fields.description.length > MAX_BODY) throw new Error('invalid_input')
  return { ...fields, title, description: fields.description.trim() }
}
export function checkProject(fields: ProjectFields) {
  const name = fields.name.trim()
  if (!name || name.length > 80) throw new Error('invalid_name')
  if (!isKey(fields.key)) throw new Error('invalid_key')
  if (!isColor(fields.color)) throw new Error('invalid_color')
  return { ...fields, name, description: fields.description.trim().slice(0, MAX_BODY) }
}

/**
 * The SQL for one action, with unqualified table names: the SQL API runs it with the project's
 * schema on the search path. Numbering, completion time, history and the default position of a
 * new task are left to the triggers.
 */
export function statement(action: ProjectsAction): Statement {
  switch (action.action) {
    case 'create-task': {
      const t = checkTask(action)
      return {
        sql: `INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, points, due_on)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        params: [action.projectId, t.title, t.description, t.status, t.priority, t.assigneeId, t.points, t.dueOn],
      }
    }
    case 'update-task': {
      const t = checkTask(action)
      // A status change from the drawer files the task at the bottom of its new column.
      return {
        sql: `UPDATE tasks SET title = $2, description = $3, priority = $5, assignee_id = $6, points = $7, due_on = $8,
                status = $4,
                position = CASE WHEN status = $4 THEN position ELSE (
                  SELECT coalesce(max(other.position), 0) + ${POSITION_STEP} FROM tasks other
                  WHERE other.project_id = tasks.project_id AND other.status = $4) END
              WHERE id = $1`,
        params: [action.taskId, t.title, t.description, t.status, t.priority, t.assigneeId, t.points, t.dueOn],
      }
    }
    case 'move-task':
      if (!statuses.includes(action.status) || !Number.isFinite(action.position)) throw new Error('invalid_input')
      return { sql: `UPDATE tasks SET status = $2, position = $3 WHERE id = $1`, params: [action.taskId, action.status, action.position] }
    case 'rebalance-column':
      return {
        sql: `UPDATE tasks SET position = ranked.n * ${POSITION_STEP}
              FROM (SELECT id, row_number() OVER (ORDER BY position, number) AS n FROM tasks
                    WHERE project_id = $1 AND status = $2) AS ranked
              WHERE tasks.id = ranked.id`,
        params: [action.projectId, action.status],
      }
    case 'delete-task':
      return { sql: `DELETE FROM tasks WHERE id = $1`, params: [action.taskId] }
    case 'add-comment': {
      const body = action.body.trim()
      if (!body || body.length > MAX_BODY) throw new Error('invalid_comment')
      return { sql: `INSERT INTO comments (task_id, author_id, body) VALUES ($1, $2, $3)`, params: [action.taskId, action.authorId, body] }
    }
    case 'save-project': {
      const p = checkProject(action)
      const params = [p.name, p.key, p.description, p.color.toLowerCase(), p.archived]
      return action.id
        ? { sql: `UPDATE projects SET name = $2, key = $3, description = $4, color = $5, archived = $6 WHERE id = $1`, params: [action.id, ...params] }
        : { sql: `INSERT INTO projects (name, key, description, color, archived) VALUES ($1, $2, $3, $4, $5)`, params }
    }
  }
}

/** One read per table, in the order the gallery preview reads them. */
export const readStatements = Object.fromEntries(
  projectsTables.map((table) => [table, `SELECT * FROM ${table} ORDER BY created_at, id`]),
) as Record<(typeof projectsTables)[number], string>

/** The gallery demo's role may only read; a copy's role may write. */
export const READ_ONLY_PROBE = `SELECT NOT has_table_privilege('tasks', 'INSERT') AS read_only`

const numericColumns =new Set(['number', 'points', 'position'])
const timeColumns = new Set(['created_at', 'completed_at', 'at'])
/**
 * The SQL API returns numeric columns as strings and timestamps as JSON dates; the app wants
 * numbers and ISO strings, the same as the gallery preview hands it.
 */
export function normalizeRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value === null || value === undefined
        ? null
        : numericColumns.has(key)
          ? Number(value)
          : timeColumns.has(key)
            ? new Date(value as string | Date).toISOString()
            : value,
    ]),
  )
}

export const localeOf = (locale: Locale) => (locale === 'zh' ? 'zh-CN' : 'en-US')
export function dayLabel(day: string, locale: Locale, withYear = false) {
  return new Intl.DateTimeFormat(localeOf(locale), {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(day + 'T00:00:00Z'))
}
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
