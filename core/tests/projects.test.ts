import { describe, expect, test } from 'bun:test'
import type { DataTemplateProps } from '../src/template-data'
import {
  POSITION_STEP,
  applyMove,
  byEventTime,
  column,
  cycleTimes,
  filterTasks,
  lastWeeks,
  latestDay,
  median,
  myWork,
  normalizeRow,
  planMove,
  positionBetween,
  projectProgress,
  sortForList,
  statement,
  taskKey,
  timeline,
  weekStart,
  weeklyVelocity,
  workload,
  type Member,
  type Project,
  type ProjectsAction,
  type ProjectsData,
  type ProjectsProps,
  type Task,
  type TaskEvent,
} from '../src/projects'

// The copy's domain file spells out the shared props; it must stay assignable both ways.
const props = {} as ProjectsProps
const shared: DataTemplateProps<ProjectsData, ProjectsAction> = props
const back: ProjectsProps = shared
void back

const project = (id: string, key: string): Project => ({ id, key, created_at: '', name: key, description: '', color: '#5e5ce6', archived: false })
const member = (id: string): Member => ({ id, created_at: '', name: id, role: '', color: '#000000' })
let serial = 0
const task = (over: Partial<Task>): Task => ({
  id: `t${++serial}`,
  created_at: '2026-10-01T02:00:00.000Z',
  project_id: 'web',
  number: serial,
  title: `Task ${serial}`,
  description: '',
  status: 'todo',
  priority: 'medium',
  assignee_id: null,
  points: null,
  due_on: null,
  position: serial * POSITION_STEP,
  completed_at: null,
  ...over,
})
const today = '2026-11-04' // a Wednesday

describe('ordering within a column', () => {
  test('a position strictly between neighbours, or a step past either end', () => {
    expect(positionBetween(null, null)).toBe(POSITION_STEP)
    expect(positionBetween(null, 1024)).toBe(0)
    expect(positionBetween(2048, null)).toBe(3072)
    expect(positionBetween(1024, 2048)).toBe(1536)
    expect(positionBetween(-3, -2)).toBe(-2.5)
  })
  test('runs out of room only after many splits of the same gap, and says so', () => {
    let low = 1024
    const high = 2048
    let splits = 0
    for (;;) {
      const next = positionBetween(low, high)
      if (next === null) break
      expect(next > low && next < high).toBe(true)
      low = next
      splits++
    }
    expect(splits).toBeGreaterThan(30)
  })
  test('planMove places a card between the cards it was dropped between', () => {
    const a = task({ position: 1000 })
    const b = task({ position: 2000 })
    const c = task({ position: 3000 })
    const moving = task({ status: 'doing', position: 500 })
    const tasks = [a, b, c, moving]
    expect(planMove(tasks, moving.id, 'todo', 0).position).toBe(1000 - POSITION_STEP)
    expect(planMove(tasks, moving.id, 'todo', 1).position).toBe(1500)
    expect(planMove(tasks, moving.id, 'todo', 3).position).toBe(3000 + POSITION_STEP)
    expect(planMove(tasks, moving.id, 'todo', 99).position).toBe(3000 + POSITION_STEP)
    expect(planMove(tasks, moving.id, 'review', 0).position).toBe(POSITION_STEP)
    // Reordering within its own column skips itself; dropping in place changes nothing.
    expect(planMove(tasks, c.id, 'todo', 0).position).toBe(1000 - POSITION_STEP)
    expect(planMove(tasks, b.id, 'todo', 1)).toEqual({ position: 2000, unchanged: true })
    const squeezed = [task({ position: 1 }), task({ position: 1 + Number.EPSILON }), moving]
    expect(planMove(squeezed, moving.id, 'todo', 1).position).toBeNull()
    expect(() => planMove(tasks, 'missing', 'todo', 0)).toThrow('record_unavailable')
  })
  test('applyMove mirrors the completion trigger', () => {
    const t = task({ status: 'review' })
    const done = applyMove([t], t.id, 'done', 5)[0]
    expect(done.status).toBe('done')
    expect(done.completed_at).not.toBeNull()
    expect(applyMove([done], t.id, 'done', 1)[0].completed_at).toBe(done.completed_at)
    expect(applyMove([done], t.id, 'todo', 1)[0].completed_at).toBeNull()
    const ordered = column(applyMove([t, task({ position: 1 })], t.id, 'todo', 0), 'web', 'todo')
    expect(ordered[0].id).toBe(t.id)
  })
  test('list order follows the board: status, then position, then number', () => {
    const tasks = [task({ status: 'done', position: 1 }), task({ status: 'backlog', position: 9 }), task({ status: 'backlog', position: 2 })]
    expect(sortForList(tasks).map((t) => [t.status, t.position])).toEqual([['backlog', 2], ['backlog', 9], ['done', 1]])
  })
})

describe('due dates and personal queues', () => {
  const tasks = [
    task({ assignee_id: 'ana', due_on: '2026-11-01', priority: 'low' }),
    task({ assignee_id: 'ana', due_on: '2026-10-28' }),
    task({ assignee_id: 'ana', due_on: today }),
    task({ assignee_id: 'ana', due_on: '2026-11-08' }),
    task({ assignee_id: 'ana', due_on: '2026-12-24' }),
    task({ assignee_id: 'ana', priority: 'urgent' }),
    task({ assignee_id: 'ana', due_on: '2026-10-01', status: 'done', completed_at: '2026-10-01T00:00:00Z' }),
    task({ assignee_id: 'ana', status: 'backlog', due_on: '2026-10-01' }),
    task({ assignee_id: 'ben', due_on: '2026-10-02', priority: 'urgent' }),
  ]
  test('my work puts overdue first, then by due date; done and backlog are not in it', () => {
    const queue = myWork(tasks, 'ana', today)
    expect(queue.map((w) => [w.group, w.task.due_on])).toEqual([
      ['overdue', '2026-10-28'],
      ['overdue', '2026-11-01'],
      ['today', today],
      ['week', '2026-11-08'],
      ['later', '2026-12-24'],
      ['undated', null],
    ])
  })
  test('filters combine', () => {
    expect(filterTasks(tasks, { due: 'overdue' }, today)).toHaveLength(4)
    expect(filterTasks(tasks, { due: 'overdue', assigneeId: 'ben' }, today)).toHaveLength(1)
    expect(filterTasks(tasks, { due: 'week' }, today).map((t) => t.due_on)).toEqual([today, '2026-11-08'])
    expect(filterTasks(tasks, { due: 'none' }, today)).toHaveLength(1)
    expect(filterTasks(tasks, { priority: 'urgent', status: 'todo' }, today)).toHaveLength(2)
    expect(filterTasks([...tasks, task({})], { assigneeId: 'none' }, today)).toHaveLength(1)
    expect(filterTasks(tasks, { query: 'TASK' }, today)).toHaveLength(tasks.length)
  })
})

describe('reports', () => {
  test('weeks start on Monday and end with the current one', () => {
    expect(weekStart(today)).toBe('2026-11-02')
    expect(weekStart('2026-11-02')).toBe('2026-11-02')
    expect(weekStart('2026-11-08')).toBe('2026-11-02')
    expect(lastWeeks(today, 3)).toEqual(['2026-10-19', '2026-10-26', '2026-11-02'])
  })
  test('weekly velocity sums points by completion week; open and older work is ignored', () => {
    const tasks = [
      task({ status: 'done', points: 3, completed_at: '2026-11-02T01:00:00.000Z' }),
      task({ status: 'done', points: 5, completed_at: '2026-11-04T09:00:00.000Z' }),
      task({ status: 'done', points: null, completed_at: '2026-10-25T23:59:59.000Z' }),
      task({ status: 'done', points: 8, completed_at: '2026-09-01T00:00:00.000Z' }),
      task({ status: 'review', points: 13 }),
    ]
    expect(weeklyVelocity(tasks, lastWeeks(today, 3))).toEqual([
      { week: '2026-10-19', points: 0, tasks: 1 },
      { week: '2026-10-26', points: 0, tasks: 0 },
      { week: '2026-11-02', points: 8, tasks: 2 },
    ])
  })
  test('project progress and workload', () => {
    const tasks = [
      task({ status: 'done', points: 3, completed_at: '2026-11-01T00:00:00Z', assignee_id: 'ana' }),
      task({ status: 'doing', points: 5, assignee_id: 'ana', due_on: '2026-11-01' }),
      task({ status: 'review', points: 2, assignee_id: 'ben' }),
      task({ status: 'backlog', points: 8, assignee_id: 'ben' }),
      task({ project_id: 'api', status: 'todo', points: 1, assignee_id: 'ben' }),
    ]
    const [web, api] = projectProgress({ projects: [project('web', 'WEB'), project('api', 'API')], tasks }, today)
    expect([web.total, web.done, web.points, web.pointsDone, web.overdue]).toEqual([4, 1, 18, 3, 1])
    expect(web.byStatus).toEqual({ backlog: 1, todo: 0, doing: 1, review: 1, done: 1 })
    expect(api.total).toBe(1)
    const load = workload({ members: [member('ben'), member('ana'), member('cy')], tasks }, today)
    expect(load.map((l) => [l.member.id, l.todo, l.doing, l.review, l.points, l.overdue])).toEqual([
      ['ana', 0, 1, 0, 5, 1],
      ['ben', 1, 0, 1, 3, 0],
      ['cy', 0, 0, 0, 0, 0],
    ])
  })
  test('cycle time runs from first entering doing to completion', () => {
    const t = task({ status: 'done', completed_at: '2026-11-03T00:00:00.000Z' })
    const event = (to: string, at: string): TaskEvent => ({ id: at, created_at: at, task_id: t.id, kind: 'status', from_value: null, to_value: to, at })
    const events = [event('doing', '2026-10-30T00:00:00.000Z'), event('doing', '2026-10-31T00:00:00.000Z'), event('done', '2026-11-03T00:00:00.000Z')]
    expect(cycleTimes({ tasks: [t], task_events: events }, '2026-11-01')).toEqual([4])
    expect(cycleTimes({ tasks: [t], task_events: events }, '2026-11-04')).toEqual([])
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
  })
  test('timeline merges history and comments; same-instant events keep trigger order', () => {
    const at = '2026-11-03T02:00:00.000Z'
    const base = { created_at: at, task_id: 't', from_value: null, to_value: null }
    const events: TaskEvent[] = [
      { ...base, id: 'b', kind: 'assignee', at },
      { ...base, id: 'a', kind: 'status', at },
      { ...base, id: 'c', kind: 'created', at: '2026-11-01T00:00:00.000Z' },
    ]
    expect([...events].sort(byEventTime).map((e) => e.id)).toEqual(['c', 'a', 'b'])
    const comments = [{ id: 'm', created_at: '2026-11-02T00:00:00.000Z', task_id: 't', author_id: null, body: 'hi' }]
    expect(timeline({ task_events: events, comments }, 't').map((e) => e.event?.id ?? e.comment?.id)).toEqual(['c', 'm', 'a', 'b'])
    expect(latestDay({ task_events: events, comments })).toBe('2026-11-03')
    expect(latestDay({ task_events: [], comments: [] })).toBeNull()
  })
})

describe('statements for the SQL API', () => {
  const fields = { title: '  Ship it ', description: '', status: 'todo' as const, priority: 'high' as const, assigneeId: null, points: 3, dueOn: null }
  test('each action is a single INSERT, UPDATE or DELETE with parameters, never interpolated values', () => {
    const actions: ProjectsAction[] = [
      { action: 'create-task', projectId: 'p', ...fields },
      { action: 'update-task', taskId: 't', ...fields },
      { action: 'move-task', taskId: 't', status: 'doing', position: 1.5 },
      { action: 'rebalance-column', projectId: 'p', status: 'doing' },
      { action: 'delete-task', taskId: 't' },
      { action: 'add-comment', taskId: 't', authorId: null, body: 'hi' },
      { action: 'save-project', name: 'Web', key: 'WEB', description: '', color: '#5E5CE6', archived: false },
      { action: 'save-project', id: 'p', name: 'Web', key: 'WEB', description: '', color: '#5e5ce6', archived: true },
    ]
    for (const action of actions) {
      const { sql, params } = statement(action)
      expect(sql.trim()).toMatch(/^(INSERT|UPDATE|DELETE)\b/)
      expect(sql).not.toContain(';')
      expect(params.length).toBeGreaterThan(0)
    }
    expect(statement(actions[0]).params[1]).toBe('Ship it')
    expect(statement(actions[6]).params[3]).toBe('#5e5ce6')
  })
  test('invalid input is refused before it is sent', () => {
    expect(() => statement({ action: 'create-task', projectId: 'p', ...fields, title: '   ' })).toThrow('invalid_title')
    expect(() => statement({ action: 'create-task', projectId: 'p', ...fields, points: 4 })).toThrow('invalid_points')
    expect(() => statement({ action: 'create-task', projectId: 'p', ...fields, dueOn: '2026-02-30' })).toThrow('invalid_date')
    expect(() => statement({ action: 'move-task', taskId: 't', status: 'doing', position: Number.NaN })).toThrow('invalid_input')
    expect(() => statement({ action: 'add-comment', taskId: 't', authorId: null, body: ' ' })).toThrow('invalid_comment')
    expect(() => statement({ action: 'save-project', name: 'x', key: 'web', description: '', color: '#000000', archived: false })).toThrow('invalid_key')
    expect(() => statement({ action: 'save-project', name: 'x', key: 'WEB', description: '', color: 'red', archived: false })).toThrow('invalid_color')
  })
  test('rows from the SQL API become the preview shape', () => {
    expect(normalizeRow({ number: '12', points: null, position: '1536.5', completed_at: new Date('2026-11-01T00:00:00Z'), at: '2026-11-01T08:00:00+08:00', title: '7' })).toEqual({
      number: 12,
      points: null,
      position: 1536.5,
      completed_at: '2026-11-01T00:00:00.000Z',
      at: '2026-11-01T00:00:00.000Z',
      title: '7',
    })
  })
  test('task keys', () => {
    expect(taskKey(project('w', 'WEB'), { number: 12 })).toBe('WEB-12')
    expect(taskKey(undefined, { number: 3 })).toBe('?-3')
  })
})
