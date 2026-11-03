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
import { defaultSla } from '../src/modules/templates/helpdesk-model'
import type { DataTemplateClient } from '@lovbase/core/template-data'
import {
  actionStatements,
  clockOf,
  errorCode,
  helpdeskTables,
  isBreached,
  isUnsolved,
  readStatements,
  type HelpdeskAction,
  type HelpdeskClient,
  type HelpdeskData,
  type Statement,
} from '@lovbase/core/helpdesk'

const one = async (c: PoolClient, text: string, params: unknown[] = []) => (await c.query(text, params)).rows[0]
const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id))

const url = process.env.TEMPLATE_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
suite('Helpdesk template on PostgreSQL', () => {
  const pool = new Pool({ connectionString: url })
  const schema = new SchemaService(pool)
  const cfg = ConfigService.of({ DATABASE_URL: url, SQL_ROLE_PASSWORD: 'templates-sql-test' })
  const roles = new RolesService(pool, cfg)
  const limits = new LimitsService(pool, cfg, schema)
  const templates = new TemplatesService(pool, schema, roles, limits)
  const projects = new ProjectsService(pool, schema, roles, limits)
  // The data API's own path: the low-privilege executor login, switched to the workspace role.
  const sqlPool = new Pool({ connectionString: cfg.sqlUrl })
  const sql = new SqlService(sqlPool, pool, limits)
  const users: string[] = []
  const ids = new Set<string>()

  async function fixture() {
    const userId = `helpdesk-test-${randomUUID()}`
    users.push(userId)
    await pool.query(
      'INSERT INTO public."user"(id,name,email,plan,"createdAt","updatedAt") VALUES($1,$1,$2,\'pro\',now(),now())',
      [userId, `${userId}@example.invalid`],
    )
    const created = await templates.create(userId, { templateId: 'helpdesk', version: 1, name: 'Helpdesk test', locale: 'en', requestId: randomUUID() })
    ids.add(created.projectId)
    return { id: created.projectId, data: (await templates.readTables(created.projectId, 'helpdesk')) as unknown as HelpdeskData }
  }
  /**
   * The copied app's client, with the HTTP hop replaced by a JSON round trip: the same statements
   * from the domain module, through SqlService as the workspace role.
   */
  async function clientFor(id: string): Promise<HelpdeskClient> {
    const role = await roles.ensureWorkspaceRole(id)
    const exec = async (s: Statement) => JSON.parse(JSON.stringify((await sql.run(role, schemaFor(id), s.sql, s.params)).rows))
    const client: HelpdeskClient = {
      async read() {
        const meta = await pool.query('SELECT read_only FROM public.lb_projects WHERE id=$1', [id])
        const data = { readOnly: !!meta.rows[0].read_only } as HelpdeskData
        for (const table of helpdeskTables) Object.assign(data, { [table]: await exec(readStatements[table]) })
        return data
      },
      async run(action) {
        for (const s of actionStatements(action)) {
          const rows = await exec(s)
          if (s.expectRow && !rows.length) throw new Error('record_unavailable')
        }
      },
    }
    // The gallery and the copy both hand the app this shared contract.
    const shared: DataTemplateClient<HelpdeskData, HelpdeskAction> = client
    return shared
  }
  // Runs as the project's own database role, the way the SQL console and data API reach it.
  async function asProject<T>(id: string, run: (c: PoolClient, table: (n: string) => string) => Promise<T>) {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SET LOCAL ROLE "${roleFor(id)}"`)
      const result = await run(c, (n) => `"${schemaFor(id)}"."${n}"`)
      await c.query('COMMIT')
      return result
    } catch (error) {
      await c.query('ROLLBACK')
      throw error
    } finally {
      c.release()
    }
  }
  beforeAll(() => schema.ready(), 30000)
  afterAll(async () => {
    for (const id of ids) await projects.remove(id)
    for (const id of users) await pool.query('DELETE FROM public."user" WHERE id=$1', [id])
    await sqlPool.end()
    await pool.end()
  })

  test('seeded month: realistic shape, every stamp agrees with the messages', async () => {
    const { data } = await fixture()
    expect(data.readOnly).toBe(false)
    expect(data.agents).toHaveLength(8)
    expect(data.customers).toHaveLength(50)
    expect(data.tickets.length).toBeGreaterThanOrEqual(100)
    expect(data.tickets.length).toBeLessThanOrEqual(140)
    for (const table of helpdeskTables) expect((data[table] as unknown[]).length).toBeLessThan(1000)
    // numeric arrives as a number, timestamps as ISO strings.
    expect(typeof data.sla_policies[0].first_response_minutes).toBe('number')
    expect(data.sla_policies.map((p) => [p.priority, p.first_response_minutes, p.resolution_minutes]).sort()).toEqual([...defaultSla].sort())
    expect(data.tickets[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    const policy = new Map(data.sla_policies.map((p) => [p.priority, p]))
    const counts: number[] = []
    for (const t of data.tickets) {
      const thread = data.messages.filter((m) => m.ticket_id === t.id).sort((a, b) => a.created_at.localeCompare(b.created_at))
      counts.push(thread.length)
      expect(thread[0]?.author_kind).toBe('customer')
      const replies = thread.filter((m) => m.author_kind === 'agent')
      expect(t.first_response_at).toBe(replies[0]?.created_at ?? null)
      expect(t.last_activity_at).toBe(thread[thread.length - 1].created_at)
      expect(t.solved_at !== null).toBe(t.status === 'solved' || t.status === 'closed')
      if (t.solved_at) expect(thread.every((m) => m.author_kind !== 'customer' || m.created_at <= t.solved_at!)).toBe(true)
      if (isUnsolved(t)) expect(t.status === 'new').toBe(replies.length === 0)
      const p = policy.get(t.priority)!
      expect(Date.parse(t.response_due_at!) - Date.parse(t.created_at)).toBe(p.first_response_minutes * 60_000)
      expect(Date.parse(t.due_at!) - Date.parse(t.created_at)).toBe(p.resolution_minutes * 60_000)
      for (const m of thread) expect((m.author_kind === 'customer') === (m.agent_id === null)).toBe(true)
    }
    // Every finished conversation has 2–7 messages; only tickets nobody has answered yet have one.
    expect(Math.max(...counts)).toBeLessThanOrEqual(7)
    expect(counts.filter((n) => n >= 2).length / counts.length).toBeGreaterThan(0.85)
    expect(new Set(data.tickets.map((t) => t.status))).toEqual(new Set(['new', 'open', 'pending', 'solved', 'closed']))
    expect(new Set(data.messages.map((m) => m.author_kind))).toEqual(new Set(['customer', 'agent', 'note']))
    const now = clockOf(data)
    const breached = data.tickets.filter((t) => isBreached(t, now))
    expect(breached.length).toBeGreaterThanOrEqual(5)
    expect(breached.length / data.tickets.length).toBeLessThan(0.35)
    expect(data.tickets.filter((t) => isUnsolved(t) && isBreached(t, now)).length).toBeGreaterThan(0)
    expect(data.tickets.filter((t) => isUnsolved(t) && !t.assignee_id).length).toBeGreaterThan(0)
    expect(data.tickets.some((t) => t.channel === 'phone') && new Set(data.tickets.map((t) => t.tags)).size >= 4).toBe(true)
    // The leaver keeps his history, and nothing open is left with him.
    const inactive = data.agents.filter((a) => !a.active)
    expect(inactive.map((a) => a.name)).toEqual(['Tom Becker'])
    expect(data.tickets.some((t) => t.assignee_id === inactive[0].id && t.solved_at)).toBe(true)
    expect(data.tickets.some((t) => t.assignee_id === inactive[0].id && isUnsolved(t))).toBe(false)
  })

  test("the client's statements read the same rows through the SQL API as the preview does", async () => {
    const { id, data } = await fixture()
    const read = await (await clientFor(id)).read()
    expect(read.readOnly).toBe(false)
    for (const table of helpdeskTables) expect(byId(read[table] as { id: string }[])).toEqual(byId(data[table] as { id: string }[]))
  })

  test('client actions through the SQL API: the triggers do the bookkeeping', async () => {
    const { id, data } = await fixture()
    const client = await clientFor(id)
    const [mia, priya] = ['Mia Chen', 'Priya Nair'].map((n) => data.agents.find((a) => a.name === n)!)
    const customer = data.customers[0]
    const ticketId = randomUUID()
    await client.run({ type: 'create-ticket', id: ticketId, customerId: customer.id, subject: 'Export stuck at 99%', body: 'The export never finishes.', priority: 'high', channel: 'phone', assigneeId: null, tags: 'Export, bug' })
    let read = await client.read()
    let t = read.tickets.find((x) => x.id === ticketId)!
    expect(t).toMatchObject({ status: 'new', tags: 'export,bug', first_response_at: null, assignee_id: null })
    expect(Date.parse(t.response_due_at!) - Date.parse(t.created_at)).toBe(60 * 60_000)

    await client.run({ type: 'reply', ticketId, agentId: mia.id, body: 'Checking the job now.', note: true })
    expect((await client.read()).tickets.find((x) => x.id === ticketId)).toMatchObject({ status: 'new', first_response_at: null })
    await client.run({ type: 'reply', ticketId, agentId: mia.id, body: 'Restarted it for you.', note: false })
    read = await client.read()
    t = read.tickets.find((x) => x.id === ticketId)!
    const reply = read.messages.find((m) => m.ticket_id === ticketId && m.author_kind === 'agent')!
    expect(t.status).toBe('open')
    expect(t.first_response_at).toBe(reply.created_at)

    await client.run({ type: 'update-ticket', ticketId, assigneeId: priya.id, priority: 'urgent', status: 'solved' })
    t = (await client.read()).tickets.find((x) => x.id === ticketId)!
    expect(t).toMatchObject({ assignee_id: priya.id, priority: 'urgent', status: 'solved' })
    expect(Date.parse(t.response_due_at!) - Date.parse(t.created_at)).toBe(30 * 60_000)
    expect(t.solved_at).not.toBeNull()
    await expect(client.run({ type: 'update-ticket', ticketId: randomUUID(), status: 'open' })).rejects.toThrow('record_unavailable')

    await client.run({ type: 'save-customer', name: 'New Person', email: 'New@Example.com', company: 'Acme', plan: 'pro' })
    read = await client.read()
    const added = read.customers.find((c) => c.email === 'new@example.com')!
    expect(added).toMatchObject({ name: 'New Person', company: 'Acme', plan: 'pro' })
    await client.run({ type: 'save-customer', id: added.id, name: 'New Person', email: 'new@example.com', company: 'Acme Ltd', plan: 'enterprise' })
    expect((await client.read()).customers.find((c) => c.id === added.id)?.plan).toBe('enterprise')
    const duplicate = await client.run({ type: 'save-customer', name: 'Copy', email: customer.email, company: '', plan: 'free' }).catch((e: Error) => e)
    expect(errorCode((duplicate as Error).message)).toBe('email_taken')

    // A policy change moves open tickets of that priority, not finished ones.
    const open = read.tickets.find((x) => x.priority === 'normal' && isUnsolved(x))!
    const done = read.tickets.find((x) => x.priority === 'normal' && !isUnsolved(x))!
    await client.run({ type: 'set-sla', priority: 'normal', firstResponseMinutes: 120, resolutionMinutes: 2880 })
    read = await client.read()
    const moved = read.tickets.find((x) => x.id === open.id)!
    expect(Date.parse(moved.due_at!) - Date.parse(moved.created_at)).toBe(2880 * 60_000)
    expect(read.tickets.find((x) => x.id === done.id)!.due_at).toBe(done.due_at)
    expect(read.sla_policies.find((p) => p.priority === 'normal')).toMatchObject({ first_response_minutes: 120, resolution_minutes: 2880 })
  })

  test('the database runs the ticket lifecycle on its own, for raw SQL as the project role', async () => {
    const { id, data } = await fixture()
    const mia = data.agents.find((a) => a.name === 'Mia Chen')!
    const customer = data.customers[0].id
    await asProject(id, async (c, t) => {
      const ticket = await one(c, `INSERT INTO ${t('tickets')}(subject, customer_id) VALUES ('Raw SQL', $1) RETURNING *`, [customer])
      expect(ticket).toMatchObject({ status: 'new', priority: 'normal', channel: 'web', solved_at: null, first_response_at: null })
      expect(ticket.response_due_at.getTime() - ticket.created_at.getTime()).toBe(240 * 60_000)
      expect(ticket.last_activity_at.getTime()).toBe(ticket.created_at.getTime())
      const say = (kind: string, agent: string | null, body = 'x') =>
        c.query(`INSERT INTO ${t('messages')}(ticket_id, author_kind, agent_id, body) VALUES ($1, $2, $3, $4)`, [ticket.id, kind, agent, body])
      const read = () => one(c, `SELECT * FROM ${t('tickets')} WHERE id = $1`, [ticket.id])

      // Raising the priority moves both targets, measured from creation.
      await c.query(`UPDATE ${t('tickets')} SET priority = 'urgent' WHERE id = $1`, [ticket.id])
      let row = await read()
      expect(row.response_due_at.getTime() - row.created_at.getTime()).toBe(30 * 60_000)
      expect(row.due_at.getTime() - row.created_at.getTime()).toBe(8 * 3600_000)

      // A note is activity, not a response.
      await say('note', mia.id)
      row = await read()
      expect(row).toMatchObject({ status: 'new', first_response_at: null })
      // The first agent message stamps the response and opens the ticket; later ones change neither.
      await say('agent', mia.id)
      row = await read()
      const first = row.first_response_at.getTime()
      expect(row.status).toBe('open')
      await say('agent', mia.id)
      expect((await read()).first_response_at.getTime()).toBe(first)

      // Waiting on the customer, until they write back.
      await c.query(`UPDATE ${t('tickets')} SET status = 'pending' WHERE id = $1`, [ticket.id])
      await say('customer', null)
      expect((await read()).status).toBe('open')
      // Solving stamps the time; a customer message reopens and clears it.
      await c.query(`UPDATE ${t('tickets')} SET status = 'solved' WHERE id = $1`, [ticket.id])
      expect((await read()).solved_at).not.toBeNull()
      await say('customer', null)
      row = await read()
      expect(row).toMatchObject({ status: 'open', solved_at: null })
      // So does an agent reopening it by hand.
      await c.query(`UPDATE ${t('tickets')} SET status = 'solved' WHERE id = $1`, [ticket.id])
      await c.query(`UPDATE ${t('tickets')} SET status = 'pending' WHERE id = $1`, [ticket.id])
      expect((await read()).solved_at).toBeNull()
      // Closing keeps the solve time and is final.
      await c.query(`UPDATE ${t('tickets')} SET status = 'solved' WHERE id = $1`, [ticket.id])
      const solved = (await read()).solved_at.getTime()
      await c.query(`UPDATE ${t('tickets')} SET status = 'closed' WHERE id = $1`, [ticket.id])
      expect((await read()).solved_at.getTime()).toBe(solved)
      expect((await read()).last_activity_at.getTime()).toBeGreaterThanOrEqual(first)
    })
    const ticket = (
      await asProject(id, (c, t) => one(c, `SELECT * FROM ${t('tickets')} WHERE subject = 'Raw SQL'`))
    ) as { id: string }
    const rejects = (text: string, params: unknown[] = []) => expect(asProject(id, (c, t) => c.query(text.replaceAll(/\{(\w+)\}/g, (_, n) => t(n)), params)))
    await rejects(`INSERT INTO {messages}(ticket_id, author_kind, agent_id, body) VALUES ($1, 'agent', $2, 'late')`, [ticket.id, mia.id]).rejects.toThrow('helpdesk_ticket_closed')
    await rejects(`UPDATE {tickets} SET status = 'open' WHERE id = $1`, [ticket.id]).rejects.toThrow('helpdesk_ticket_closed')
    await rejects(`UPDATE {tickets} SET assignee_id = $2 WHERE id = $1`, [ticket.id, mia.id]).rejects.toThrow('helpdesk_ticket_closed')
  })

  test('constraints and guards reject what would corrupt the history', async () => {
    const { id, data } = await fixture()
    const mia = data.agents.find((a) => a.name === 'Mia Chen')!
    const tom = data.agents.find((a) => a.name === 'Tom Becker')!
    const open = data.tickets.find((t) => t.status === 'open')!
    const message = data.messages[0]
    const run = (text: string, params: unknown[] = []) =>
      asProject(id, (c, t) => c.query(text.replaceAll(/\{(\w+)\}/g, (_, n) => t(n)), params))
    // Notes need an agent; customer messages must not claim one.
    await expect(run(`INSERT INTO {messages}(ticket_id, author_kind, body) VALUES ($1, 'note', 'x')`, [open.id])).rejects.toThrow('messages_author_check')
    await expect(run(`INSERT INTO {messages}(ticket_id, author_kind, agent_id, body) VALUES ($1, 'customer', $2, 'x')`, [open.id, mia.id])).rejects.toThrow('messages_author_check')
    await expect(run(`INSERT INTO {messages}(ticket_id, author_kind, agent_id, body) VALUES ($1, 'agent', $2, '  ')`, [open.id, mia.id])).rejects.toThrow('check')
    await expect(run(`INSERT INTO {messages}(ticket_id, author_kind, agent_id, body, created_at) VALUES ($1, 'agent', $2, 'x', $3)`, [open.id, mia.id, '2000-01-01'])).rejects.toThrow('helpdesk_message_before_ticket')
    // Messages are append-only.
    await expect(run(`UPDATE {messages} SET body = 'rewritten' WHERE id = $1`, [message.id])).rejects.toThrow('helpdesk_messages_append_only')
    // Enumerations.
    for (const [column, value] of [['status', 'archived'], ['priority', 'critical'], ['channel', 'fax']])
      await expect(run(`UPDATE {tickets} SET ${column} = $2 WHERE id = $1`, [open.id, value])).rejects.toThrow('check')
    await expect(run(`INSERT INTO {customers}(name, email, plan) VALUES ('X', 'x@y.z', 'gold')`)).rejects.toThrow('check')
    await expect(run(`INSERT INTO {customers}(name, email) VALUES ('X', 'not-an-email')`)).rejects.toThrow('check')
    await expect(run(`INSERT INTO {agents}(name, email, team) VALUES ('X', 'x@y.z', 'sales')`)).rejects.toThrow('check')
    await expect(run(`UPDATE {sla_policies} SET resolution_minutes = 1 WHERE priority = 'low'`)).rejects.toThrow('check')
    await expect(run(`UPDATE {sla_policies} SET first_response_minutes = 1.5 WHERE priority = 'low'`)).rejects.toThrow('check')
    // Derived columns belong to the triggers.
    await expect(run(`UPDATE {tickets} SET first_response_at = now() WHERE id = $1`, [open.id])).rejects.toThrow('helpdesk_first_response_derived')
    await expect(run(`INSERT INTO {tickets}(subject, customer_id, first_response_at) VALUES ('x', $1, now())`, [open.customer_id])).rejects.toThrow('helpdesk_first_response_derived')
    await expect(run(`UPDATE {tickets} SET solved_at = now() WHERE id = $1`, [open.id])).resolves.toBeDefined()
    expect((await asProject(id, (c, t) => one(c, `SELECT solved_at FROM ${t('tickets')} WHERE id = $1`, [open.id]))).solved_at).toBeNull()
    // Lifecycle shortcuts.
    await expect(run(`UPDATE {tickets} SET status = 'closed' WHERE id = $1`, [open.id])).rejects.toThrow('helpdesk_close_unsolved')
    await expect(run(`INSERT INTO {tickets}(subject, customer_id, status) VALUES ('x', $1, 'closed')`, [open.customer_id])).rejects.toThrow('helpdesk_close_unsolved')
    await expect(run(`UPDATE {tickets} SET assignee_id = $2 WHERE id = $1`, [open.id, tom.id])).rejects.toThrow('helpdesk_agent_inactive')
    await expect(run(`INSERT INTO {tickets}(subject, customer_id) VALUES ('  ', $1)`, [open.customer_id])).rejects.toThrow('check')
    // Nothing above left a trace.
    const after = await (await clientFor(id)).read()
    expect(after.messages).toHaveLength(data.messages.length)
    expect(after.tickets.find((t) => t.id === open.id)).toEqual(open)
  })

  test('the gallery demo is read-only and the preview gets numbers', async () => {
    const demoId = await templates.ensureDemo('helpdesk')
    const demo = (await templates.readTables(demoId, 'helpdesk')) as unknown as HelpdeskData
    expect(demo.readOnly).toBe(true)
    expect(demo.tickets.length).toBeGreaterThan(100)
    for (const p of demo.sla_policies) {
      expect(typeof p.first_response_minutes).toBe('number')
      expect(typeof p.resolution_minutes).toBe('number')
    }
    const open = demo.tickets.find((t) => isUnsolved(t))!
    const agent = demo.agents[0]
    await expect(
      asProject(demoId, (c, t) => c.query(`INSERT INTO ${t('messages')}(ticket_id, author_kind, agent_id, body) VALUES ($1, 'agent', $2, 'x')`, [open.id, agent.id])),
    ).rejects.toThrow()
    const client = await clientFor(demoId)
    expect((await client.read()).readOnly).toBe(true)
    await expect(client.run({ type: 'update-ticket', ticketId: open.id, status: 'solved' })).rejects.toThrow()
    expect((await templates.readTables(demoId, 'helpdesk')).tickets).toEqual(demo.tickets)
  })
})
