import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Pool, type PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { SchemaService } from '../src/database/schema.service'
import { ConfigService } from '../src/config/config.service'
import { RolesService, roleFor, schemaFor } from '../src/modules/roles/roles.service'
import { TemplatesService } from '../src/modules/templates/templates.service'
import { ProjectsService } from '../src/modules/projects/projects.service'
import { LimitsService } from '../src/modules/limits/limits.service'
import { SqlService } from '../src/modules/sql/sql.service'
import {
  POSITION_STEP,
  READ_ONLY_PROBE,
  byEventTime,
  column,
  normalizeRow,
  projectsTables,
  readStatements,
  statement,
  statuses,
  type ProjectsAction,
  type ProjectsData,
  type Task,
} from '@lovbase/core/projects'

const taskByTitle = (data: ProjectsData, title: string) => data.tasks.find((t) => t.title === title)!
const eventsOf = (data: ProjectsData, task: Task) =>
  data.task_events.filter((e) => e.task_id === task.id).sort(byEventTime)

const url = process.env.TEMPLATE_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
suite('Project Board template on PostgreSQL', () => {
  const pool = new Pool({ connectionString: url, max: 30 })
  const schema = new SchemaService(pool)
  const cfg = ConfigService.of({ DATABASE_URL: url, SQL_ROLE_PASSWORD: 'templates-sql-test' })
  const roles = new RolesService(pool, cfg)
  const limits = new LimitsService(pool, cfg, schema)
  const templates = new TemplatesService(pool, schema, roles, limits)
  const projects = new ProjectsService(pool, schema, roles, limits)
  // The SQL API itself, the way data.controller.ts serves a copy's sql() calls.
  const sqlApi = new SqlService(pool, pool, limits)
  const users: string[] = []
  const ids = new Set<string>()

  async function fixture() {
    const userId = `projects-test-${randomUUID()}`
    users.push(userId)
    await pool.query(
      'INSERT INTO public."user"(id,name,email,plan,"createdAt","updatedAt") VALUES($1,$1,$2,\'pro\',now(),now())',
      [userId, `${userId}@example.invalid`],
    )
    const created = await templates.create(userId, {
      templateId: 'projects',
      version: 1,
      name: 'Board test',
      locale: 'en',
      requestId: randomUUID(),
    })
    ids.add(created.projectId)
    const data = (await templates.readTables(created.projectId, 'projects')) as unknown as ProjectsData
    const project = (key: string) => data.projects.find((p) => p.key === key)!
    return { id: created.projectId, data, project }
  }
  /** Exactly what src/client.ts sends: one statement through the SQL API as the workspace role. */
  async function run(id: string, action: ProjectsAction) {
    const { sql, params } = statement(action)
    return sqlApi.run(await roles.ensureWorkspaceRole(id), schemaFor(id), sql, params)
  }
  /** Exactly what src/client.ts reads, normalized the way it normalizes. */
  async function read(id: string): Promise<ProjectsData> {
    const role = await roles.ensureWorkspaceRole(id)
    const probe = await sqlApi.run(role, schemaFor(id), READ_ONLY_PROBE)
    const tables = await Promise.all(projectsTables.map((t) => sqlApi.run(role, schemaFor(id), readStatements[t])))
    return {
      readOnly: !!probe.rows[0].read_only,
      ...Object.fromEntries(projectsTables.map((t, i) => [t, tables[i].rows.map(normalizeRow)])),
    } as ProjectsData
  }
  // Runs as the project's own database role, the way the SQL console and data API reach it.
  async function asProject<T>(id: string, body: (c: PoolClient, table: (n: string) => string) => Promise<T>) {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SET LOCAL ROLE "${roleFor(id)}"`)
      const result = await body(c, (n) => `"${schemaFor(id)}"."${n}"`)
      await c.query('COMMIT')
      return result
    } catch (error) {
      await c.query('ROLLBACK')
      throw error
    } finally {
      c.release()
    }
  }
  const fields = {
    title: 'Write the launch email',
    description: '',
    status: 'todo' as const,
    priority: 'medium' as const,
    assigneeId: null,
    points: 3,
    dueOn: '2026-12-01',
  }
  beforeAll(() => schema.ready(), 30000)
  afterAll(async () => {
    for (const id of ids) await projects.remove(id)
    for (const id of users) await pool.query('DELETE FROM public."user" WHERE id=$1', [id])
    await pool.end()
  })

  test('seeded board: realistic volume, numbers in order, history consistent with every task', async () => {
    const { data } = await fixture()
    expect(data.readOnly).toBe(false)
    expect(data.members).toHaveLength(6)
    expect(data.projects.map((p) => p.key)).toEqual(['WEB', 'MOB', 'API'])
    expect(data.tasks.length).toBeGreaterThanOrEqual(55)
    expect(data.comments.length).toBeGreaterThan(20)
    for (const s of statuses) expect(data.tasks.some((t) => t.status === s)).toBe(true)
    for (const p of data.projects) {
      const numbers = data.tasks.filter((t) => t.project_id === p.id).map((t) => t.number).sort((a, b) => a - b)
      expect(numbers).toEqual(numbers.map((_, i) => i + 1))
    }
    for (const task of data.tasks) {
      const events = eventsOf(data, task)
      // Replay the trigger-written history: it must arrive exactly at the task's current state.
      expect(events[0].kind).toBe('created')
      expect(events[0].at).toBe(task.created_at)
      let status = events[0].to_value
      const assigneeEvents = events.filter((e) => e.kind === 'assignee')
      let assignee = assigneeEvents.length ? assigneeEvents[0].from_value : task.assignee_id
      let enteredDone: string | null = null
      for (const e of events.slice(1)) {
        if (e.kind === 'status') {
          expect(e.from_value).toBe(status)
          status = e.to_value
          if (status === 'done') enteredDone = e.at
        } else {
          expect(e.kind).toBe('assignee')
          expect(e.from_value).toBe(assignee)
          assignee = e.to_value
        }
        expect(e.at >= task.created_at).toBe(true)
        expect(Date.parse(e.at)).toBeLessThanOrEqual(Date.now())
      }
      expect(status).toBe(task.status)
      expect(assignee).toBe(task.assignee_id)
      expect(task.completed_at).toBe(task.status === 'done' ? enteredDone : null)
    }
    // Eight weeks of completions, so the velocity chart has a full history to draw.
    const weeks = new Set(data.tasks.filter((t) => t.completed_at).map((t) => Math.floor((Date.now() - Date.parse(t.completed_at!)) / (7 * 86_400_000))))
    expect(weeks.size).toBeGreaterThanOrEqual(7)
    expect(data.task_events.some((e) => e.kind === 'assignee' && e.from_value !== null)).toBe(true)
    for (const c of data.comments) expect(c.created_at >= data.tasks.find((t) => t.id === c.task_id)!.created_at).toBe(true)
  })

  test('client statements run through the SQL API; triggers number, stamp and record', async () => {
    const { id, data, project } = await fixture()
    const web = project('WEB')
    const before = data.tasks.filter((t) => t.project_id === web.id)
    const member = data.members[1]
    await run(id, { action: 'create-task', projectId: web.id, ...fields, assigneeId: member.id })
    let now = await read(id)
    expect(now).toEqual((await templates.readTables(id, 'projects')) as unknown as ProjectsData)
    const created = taskByTitle(now, fields.title)
    expect(created.number).toBe(Math.max(...before.map((t) => t.number)) + 1)
    expect(created.position).toBe(Math.max(...before.filter((t) => t.status === 'todo').map((t) => t.position)) + POSITION_STEP)
    expect(created.completed_at).toBeNull()
    expect(eventsOf(now, created).map((e) => [e.kind, e.to_value])).toEqual([['created', 'todo']])

    // Drag to the top of review, between nothing and the current first card.
    const top = column(now.tasks, web.id, 'review')[0]
    await run(id, { action: 'move-task', taskId: created.id, status: 'review', position: top.position - POSITION_STEP })
    now = await read(id)
    expect(column(now.tasks, web.id, 'review')[0].id).toBe(created.id)
    // Into done: completion stamped. Reordering inside done keeps the original stamp.
    await run(id, { action: 'move-task', taskId: created.id, status: 'done', position: 1.5 })
    now = await read(id)
    const done = taskByTitle(now, fields.title)
    expect(done.completed_at).not.toBeNull()
    await run(id, { action: 'move-task', taskId: created.id, status: 'done', position: 0.75 })
    now = await read(id)
    expect(taskByTitle(now, fields.title).completed_at).toBe(done.completed_at)
    expect(taskByTitle(now, fields.title).position).toBe(0.75)
    // Back out of done from the drawer: cleared, filed at the bottom of todo, reassigned.
    const other = data.members[2]
    await run(id, { action: 'update-task', taskId: created.id, ...fields, title: 'Write the launch email v2', assigneeId: other.id })
    now = await read(id)
    const reopened = taskByTitle(now, 'Write the launch email v2')
    expect(reopened.completed_at).toBeNull()
    expect(column(now.tasks, web.id, 'todo').at(-1)!.id).toBe(created.id)
    expect(eventsOf(now, reopened).map((e) => [e.kind, e.from_value, e.to_value])).toEqual([
      ['created', null, 'todo'],
      ['status', 'todo', 'review'],
      ['status', 'review', 'done'],
      ['status', 'done', 'todo'],
      ['assignee', member.id, other.id],
    ])
    // A title-only edit records nothing.
    await run(id, { action: 'update-task', taskId: created.id, ...fields, title: 'Launch email', assigneeId: other.id })
    now = await read(id)
    expect(eventsOf(now, taskByTitle(now, 'Launch email'))).toHaveLength(5)

    await run(id, { action: 'add-comment', taskId: created.id, authorId: member.id, body: '  Looks good  ' })
    now = await read(id)
    expect(now.comments.find((c) => c.task_id === created.id)?.body).toBe('Looks good')

    // Squeezed neighbours are spaced out again in one statement, keeping their order.
    const todo = column(now.tasks, web.id, 'todo').map((t) => t.id)
    await run(id, { action: 'rebalance-column', projectId: web.id, status: 'todo' })
    now = await read(id)
    expect(column(now.tasks, web.id, 'todo').map((t) => t.id)).toEqual(todo)
    expect(column(now.tasks, web.id, 'todo').map((t) => t.position)).toEqual(todo.map((_, i) => (i + 1) * POSITION_STEP))

    // Deleting takes the comments and history with it.
    await run(id, { action: 'delete-task', taskId: created.id })
    now = await read(id)
    expect(now.tasks.some((t) => t.id === created.id)).toBe(false)
    expect(now.comments.some((c) => c.task_id === created.id)).toBe(false)
    expect(now.task_events.some((e) => e.task_id === created.id)).toBe(false)

    await run(id, { action: 'save-project', name: 'Design system', key: 'DS', description: '', color: '#8E4EC6', archived: false })
    now = await read(id)
    const ds = now.projects.find((p) => p.key === 'DS')!
    expect(ds.color).toBe('#8e4ec6')
    await run(id, { action: 'create-task', projectId: ds.id, ...fields })
    now = await read(id)
    expect(now.tasks.find((t) => t.project_id === ds.id)?.number).toBe(1)
    await run(id, { action: 'save-project', id: ds.id, name: 'Design system', key: 'DS', description: 'Shelved', color: '#8e4ec6', archived: true })
    await expect(run(id, { action: 'create-task', projectId: ds.id, ...fields })).rejects.toThrow('project_archived')
  })

  test('concurrent inserts into one project get distinct, consecutive numbers', async () => {
    const { id, data, project } = await fixture()
    const api = project('API')
    const start = Math.max(...data.tasks.filter((t) => t.project_id === api.id).map((t) => t.number))
    // Two open transactions: the second insert waits on the project row until the first commits,
    // then reads the new maximum instead of the stale one.
    const first = await pool.connect()
    const second = await pool.connect()
    const insert = (c: PoolClient, title: string) =>
      c.query(`INSERT INTO "${schemaFor(id)}".tasks(project_id, title) VALUES($1, $2) RETURNING number`, [api.id, title])
    try {
      for (const c of [first, second]) {
        await c.query('BEGIN')
        await c.query(`SET LOCAL ROLE "${roleFor(id)}"`)
      }
      const a = await insert(first, 'Race A')
      let settled = false
      const b = insert(second, 'Race B').then((r) => ((settled = true), r))
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(settled).toBe(false)
      await first.query('COMMIT')
      const rows = (await b).rows
      await second.query('COMMIT')
      expect([Number(a.rows[0].number), Number(rows[0].number)]).toEqual([start + 1, start + 2])
    } finally {
      first.release()
      second.release()
    }
    // And a burst through the SQL API, each request its own transaction.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => run(id, { action: 'create-task', projectId: api.id, ...fields, title: `Burst ${i}` })),
    )
    const now = await read(id)
    const burst = now.tasks.filter((t) => t.title.startsWith('Burst ')).map((t) => t.number).sort((a, b) => a - b)
    expect(burst).toEqual(Array.from({ length: 12 }, (_, i) => start + 3 + i))
  }, 20000)

  test('the database rejects what the board would never write', async () => {
    const { id, data, project } = await fixture()
    const web = project('WEB')
    const task = data.tasks.find((t) => t.status === 'doing')!
    const write = (sql: string, params: unknown[] = []) => asProject(id, (c, t) => c.query(sql.replaceAll('$T', t('tasks')).replaceAll('$E', t('task_events')).replaceAll('$P', t('projects')), params))
    const insert = (name: string, value: unknown) =>
      write(`INSERT INTO $T(project_id, title, ${name}) VALUES($1, 'x', $2)`, [web.id, value])
    await expect(insert('status', 'blocked')).rejects.toThrow('check constraint')
    await expect(insert('priority', 'critical')).rejects.toThrow('check constraint')
    await expect(insert('points', 4)).rejects.toThrow('check constraint')
    await expect(insert('due_on', '2026/12/01')).rejects.toThrow('check constraint')
    await expect(insert('due_on', '2026-02-30')).rejects.toThrow()
    await expect(write(`INSERT INTO $T(project_id, title) VALUES($1, '   ')`, [web.id])).rejects.toThrow('check constraint')
    await expect(write(`INSERT INTO $P(name, key) VALUES('Lower', 'web2')`)).rejects.toThrow('check constraint')
    await expect(write(`INSERT INTO $P(name, key) VALUES('Duplicate', 'WEB')`)).rejects.toThrow('duplicate key')
    // Identity is fixed, a hand-written number or completion time is overwritten by the trigger.
    await expect(write(`UPDATE $T SET number = 999 WHERE id = $1`, [task.id])).rejects.toThrow('task_identity_locked')
    await expect(write(`UPDATE $T SET project_id = $2 WHERE id = $1`, [task.id, project('MOB').id])).rejects.toThrow('task_identity_locked')
    const forged = await write(`INSERT INTO $T(project_id, title, number, completed_at) VALUES($1, 'Forged', 1, '2020-01-01') RETURNING number, completed_at`, [web.id])
    expect(Number(forged.rows[0].number)).toBeGreaterThan(1)
    expect(forged.rows[0].completed_at).toBeNull()
    const stamped = await write(`UPDATE $T SET completed_at = '2020-01-01' WHERE id = $1 RETURNING completed_at`, [task.id])
    expect(stamped.rows[0].completed_at).toBeNull()
    // History is append-only.
    const event = data.task_events.find((e) => e.task_id === task.id)!
    await expect(write(`UPDATE $E SET to_value = 'done' WHERE id = $1`, [event.id])).rejects.toThrow('history_append_only')
    await expect(write(`DELETE FROM $E WHERE id = $1`, [event.id])).rejects.toThrow('history_append_only')
    await expect(write(`INSERT INTO $E(task_id, kind) VALUES($1, 'renamed')`, [task.id])).rejects.toThrow('check constraint')
    // The client checks first, with the same rules.
    expect(() => statement({ action: 'create-task', projectId: web.id, ...fields, points: 4 })).toThrow('invalid_points')
    expect(() => statement({ action: 'create-task', projectId: web.id, ...fields, dueOn: '2026-02-30' })).toThrow('invalid_date')
    expect((await read(id)).tasks).toHaveLength(data.tasks.length + 1)
  })

  test('the gallery demo is read-only and reads back numbers', async () => {
    const demoId = await templates.ensureDemo('projects')
    const demo = (await templates.readTables(demoId, 'projects')) as unknown as ProjectsData
    expect(demo.readOnly).toBe(true)
    expect(demo.tasks.length).toBeGreaterThan(50)
    for (const t of demo.tasks) {
      expect(typeof t.number).toBe('number')
      expect(typeof t.position).toBe('number')
      expect(t.points === null || typeof t.points === 'number').toBe(true)
      expect(t.completed_at === null || t.completed_at.endsWith('Z')).toBe(true)
    }
    expect(typeof demo.task_events[0].at).toBe('string')
    // The copy's client sees the same rows the gallery does, and knows it may not write.
    expect(await read(demoId)).toEqual(demo)
    const task = demo.tasks[0]
    const move = statement({ action: 'move-task', taskId: task.id, status: 'done', position: 1 })
    await expect(run(demoId, { action: 'move-task', taskId: task.id, status: 'done', position: 1 })).rejects.toThrow()
    // Even past the API's account checks, the demo's role itself holds no write privilege.
    await expect(
      asProject(demoId, async (c) => {
        await c.query(`SET LOCAL search_path = "${schemaFor(demoId)}"`)
        return c.query(move.sql, move.params)
      }),
    ).rejects.toThrow('permission denied')
    await expect(
      asProject(demoId, (c, t) => c.query(`INSERT INTO ${t('comments')}(task_id, body) VALUES($1, 'hi')`, [task.id])),
    ).rejects.toThrow('permission denied')
  })
})
