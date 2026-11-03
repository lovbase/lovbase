import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { SchemaService } from '../src/database/schema.service'
import { ConfigService } from '../src/config/config.service'
import { RolesService, roleFor, schemaFor } from '../src/modules/roles/roles.service'
import { TemplatesService } from '../src/modules/templates/templates.service'
import { ProjectsService } from '../src/modules/projects/projects.service'
import { LimitsService } from '../src/modules/limits/limits.service'
import { SqlService } from '../src/modules/sql/sql.service'
import { crmReads, crmStatement, isClosed, stages, type CrmAction, type CrmData, type Deal } from '@lovbase/core/crm'

const url = process.env.TEMPLATE_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
suite('Sales Pipeline CRM template on PostgreSQL', () => {
  const pool = new Pool({ connectionString: url })
  const schema = new SchemaService(pool)
  const cfg = ConfigService.of({ DATABASE_URL: url, SQL_ROLE_PASSWORD: 'templates-sql-test' })
  const roles = new RolesService(pool, cfg)
  const limits = new LimitsService(pool, cfg, schema)
  const templates = new TemplatesService(pool, schema, roles, limits)
  const projects = new ProjectsService(pool, schema, roles, limits)
  // The data API's executor connection: logs in as the low-privilege SQL role, like production.
  const sqlPool = new Pool({ connectionString: cfg.sqlUrl })
  const sql = new SqlService(sqlPool, pool, limits)
  const users: string[] = []
  const ids = new Set<string>()
  async function fixture() {
    const userId = `crm-test-${randomUUID()}`
    users.push(userId)
    await pool.query(
      'INSERT INTO public."user"(id,name,email,plan,"createdAt","updatedAt") VALUES($1,$1,$2,\'pro\',now(),now())',
      [userId, `${userId}@example.invalid`],
    )
    const created = await templates.create(userId, { templateId: 'crm', version: 1, name: 'CRM test', locale: 'en', requestId: randomUUID() })
    ids.add(created.projectId)
    const data = (await templates.readTables(created.projectId, 'crm')) as unknown as CrmData
    return { id: created.projectId, data }
  }
  /** What the copy's src/client.ts does: the same statements, through the same SQL path. */
  async function client(id: string) {
    const role = await roles.ensureWorkspaceRole(id)
    return {
      read: async () => {
        const data: Record<string, unknown> = { readOnly: false }
        for (const read of crmReads) data[read.table] = (await sql.run(role, schemaFor(id), read.sql)).rows
        // The data API sends these rows as JSON, which is what turns timestamps into ISO strings.
        return JSON.parse(JSON.stringify(data)) as CrmData
      },
      run: async (action: CrmAction) => {
        const statement = crmStatement(action)
        return (await sql.run(role, schemaFor(id), statement.sql, statement.params)).rows as { id: string }[]
      },
    }
  }
  // Runs as the project's own database role, the way the SQL console and data API reach it.
  async function asProject<T>(id: string, run: (c: import('pg').PoolClient, table: (n: string) => string) => Promise<T>) {
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
  const today = async () => (await pool.query(`SELECT to_char(current_date, 'YYYY-MM-DD') AS d`)).rows[0].d as string
  beforeAll(() => schema.ready(), 30000)
  afterAll(async () => {
    for (const id of ids) await projects.remove(id)
    for (const id of users) await pool.query('DELETE FROM public."user" WHERE id=$1', [id])
    await sqlPool.end()
    await pool.end()
  })

  test('seeded pipeline is consistent with the rules the triggers enforce', async () => {
    const { data } = await fixture()
    expect(data.readOnly).toBe(false)
    expect(data.companies).toHaveLength(12)
    expect(data.contacts).toHaveLength(25)
    expect(data.deals).toHaveLength(35)
    expect(new Set(data.deals.map((d) => d.stage))).toEqual(new Set(stages))
    expect(typeof data.deals[0].amount_cents).toBe('number')
    expect(typeof data.deals[0].probability).toBe('number')
    expect(data.deal_stage_history[0].changed_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    const contacts = new Map(data.contacts.map((c) => [c.id, c]))
    for (const c of data.contacts) expect(c.email).toEndWith('.example.invalid')
    for (const deal of data.deals) {
      expect(isClosed(deal.stage)).toBe(deal.closed_on !== null)
      if (deal.stage === 'won') expect(deal.probability).toBe(100)
      if (deal.stage === 'lost') expect([deal.probability, typeof deal.lost_reason]).toEqual([0, 'string'])
      else expect(deal.lost_reason).toBeNull()
      if (deal.contact_id) expect(contacts.get(deal.contact_id)?.company_id).toBe(deal.company_id)
      // History is a chain from creation to where the deal stands, in time order.
      const history = data.deal_stage_history
        .filter((h) => h.deal_id === deal.id)
        .sort((a, b) => a.changed_at.localeCompare(b.changed_at))
      expect(history[0].from_stage).toBeNull()
      expect(history[0].to_stage).toBe('lead')
      for (let i = 1; i < history.length; i++) expect(history[i].from_stage).toBe(history[i - 1].to_stage)
      expect(history[history.length - 1].to_stage).toBe(deal.stage)
      if (deal.closed_on) expect(history[history.length - 1].changed_at.slice(0, 10)).toBe(deal.closed_on)
    }
    expect(new Set(data.activities.map((a) => a.kind))).toEqual(new Set(['note', 'call', 'meeting', 'email', 'task']))
    for (const a of data.activities) expect(a.kind === 'task' || a.due_on === null).toBe(true)
    expect(data.activities.some((a) => a.kind === 'task' && !a.done)).toBe(true)
    const won = new Set(data.deals.filter((d) => d.stage === 'won').map((d) => d.closed_on!.slice(0, 7)))
    expect(won.size).toBeGreaterThanOrEqual(4)
  })

  test("the client's statements work through the SQL API, and the triggers do the bookkeeping", async () => {
    const { id, data } = await fixture()
    const api = await client(id)
    const read = await api.read()
    // Same rows and the same shape as the gallery's readTables.
    for (const table of ['companies', 'contacts', 'deals', 'activities', 'deal_stage_history'] as const)
      expect(read[table].length).toBe(data[table].length)
    const sample = read.deals.find((d) => d.id === data.deals[0].id)!
    expect(sample.amount_cents).toBe(data.deals[0].amount_cents)
    expect(typeof sample.probability).toBe('number')

    const [company] = await api.run({ action: 'create-company', name: ' Lantern Labs ', industry: 'software', website: '', city: 'Hong Kong' })
    const [contact] = await api.run({ action: 'create-contact', companyId: company.id, name: 'Ana Ruiz', title: 'COO', email: 'ana@lantern.example.invalid', phone: '' })
    const [created] = await api.run({
      action: 'create-deal', stage: 'lead', companyId: company.id, contactId: contact.id, title: 'Pilot',
      amountCents: 1_200_000, probability: 30, expectedClose: '2027-01-15', owner: 'Alex Morgan',
    })
    const dealOf = async () => (await api.read()).deals.find((d) => d.id === created.id)!
    const historyOf = async () =>
      (await api.read()).deal_stage_history.filter((h) => h.deal_id === created.id).sort((a, b) => a.changed_at.localeCompare(b.changed_at))
    expect(await dealOf()).toMatchObject({ stage: 'lead', probability: 30, closed_on: null })
    expect((await historyOf()).map((h) => [h.from_stage, h.to_stage])).toEqual([[null, 'lead']])

    const move = (from: Deal['stage'], to: Deal['stage'], lostReason?: string) => api.run({ action: 'move-deal', id: created.id, from, to, lostReason })
    expect(await move('lead', 'qualified')).toHaveLength(1)
    expect(await dealOf()).toMatchObject({ stage: 'qualified', probability: 25 })
    // A stale move (the deal is no longer a lead) touches nothing; the client reports it.
    expect(await move('lead', 'proposal')).toHaveLength(0)
    await move('qualified', 'won')
    expect(await dealOf()).toMatchObject({ stage: 'won', probability: 100, closed_on: await today() })
    await move('won', 'lost', 'competitor')
    expect(await dealOf()).toMatchObject({ stage: 'lost', probability: 0, lost_reason: 'competitor' })
    await move('lost', 'negotiation')
    expect(await dealOf()).toMatchObject({ stage: 'negotiation', probability: 75, closed_on: null, lost_reason: null })
    expect((await historyOf()).map((h) => h.to_stage)).toEqual(['lead', 'qualified', 'won', 'lost', 'negotiation'])

    await api.run({ action: 'update-deal', id: created.id, companyId: company.id, contactId: contact.id, title: 'Pilot, phase 1', amountCents: 1_500_000, probability: 80, expectedClose: null, owner: 'Alex Morgan' })
    expect(await dealOf()).toMatchObject({ title: 'Pilot, phase 1', amount_cents: 1_500_000, probability: 80, expected_close: null })
    expect(await historyOf()).toHaveLength(5)

    const [task] = await api.run({ action: 'add-activity', dealId: created.id, kind: 'task', body: 'Send contract', dueOn: '2027-01-05' })
    const [note] = await api.run({ action: 'add-activity', dealId: created.id, kind: 'note', body: 'Met the board', dueOn: '2027-01-05' })
    await api.run({ action: 'set-activity-done', id: task.id, done: true })
    expect(await api.run({ action: 'set-activity-done', id: note.id, done: true })).toHaveLength(0)
    const activities = (await api.read()).activities
    expect(activities.find((a) => a.id === task.id)).toMatchObject({ done: true, due_on: '2027-01-05' })
    expect(activities.find((a) => a.id === note.id)).toMatchObject({ done: false, due_on: null })

    // The contact has to work at the deal's company.
    const other = data.contacts.find((c) => c.company_id !== company.id)!
    await expect(
      api.run({ action: 'update-deal', id: created.id, companyId: company.id, contactId: other.id, title: 'x', amountCents: 1, probability: 1, expectedClose: null, owner: '' }),
    ).rejects.toThrow('crm_contact_company')
  })

  test('the database rejects what the rules forbid, whoever writes it', async () => {
    const { id, data } = await fixture()
    const deal = data.deals.find((d) => d.stage === 'proposal')!
    const won = data.deals.find((d) => d.stage === 'won')!
    const raw = (text: string, params: unknown[] = []) => asProject(id, (c, t) => c.query(text.replace(/\{(\w+)\}/g, (_, n) => t(n)), params))
    // Stage history has one author.
    await expect(raw(`INSERT INTO {deal_stage_history}(deal_id,to_stage) VALUES($1,'won')`, [deal.id])).rejects.toThrow('crm_history_is_automatic')
    await expect(raw(`UPDATE {deal_stage_history} SET to_stage='won' WHERE deal_id=$1`, [deal.id])).rejects.toThrow('crm_history_is_automatic')
    await expect(raw(`DELETE FROM {deal_stage_history} WHERE deal_id=$1`, [deal.id])).rejects.toThrow('crm_history_is_automatic')
    // CHECKs: probability range, whole non-negative cents, stage names, date formats, task-only due dates.
    const insert = `INSERT INTO {deals}(company_id,title,stage,amount_cents,probability,expected_close) VALUES($1,'Bad',$2,$3,$4,$5)`
    for (const [stage, cents, probability, expected] of [
      ['lead', 100, 150, null],
      ['lead', -1, 10, null],
      ['lead', 1.5, 10, null],
      ['bogus', 100, 10, null],
      ['lead', 100, 10, '2026/01/01'],
      ['lead', 100, 10.5, null],
    ])
      await expect(raw(insert, [deal.company_id, stage, cents, probability, expected])).rejects.toThrow()
    await expect(raw(`INSERT INTO {activities}(deal_id,kind,body,due_on) VALUES($1,'note','x','2026-01-01')`, [deal.id])).rejects.toThrow('check constraint')
    await expect(raw(`INSERT INTO {activities}(deal_id,kind,body) VALUES($1,'fax','x')`, [deal.id])).rejects.toThrow('check constraint')
    await expect(raw(`INSERT INTO {contacts}(company_id,name,email) VALUES($1,'X','not-an-email')`, [deal.company_id])).rejects.toThrow('check constraint')
    // A closed deal keeps its close date; its probability cannot drift from 100.
    await expect(raw(`UPDATE {deals} SET closed_on=NULL WHERE id=$1`, [won.id])).rejects.toThrow('check constraint')
    await raw(`UPDATE {deals} SET probability=40 WHERE id=$1`, [won.id])
    // A raw stage change gets the same bookkeeping as the app's.
    await raw(`UPDATE {deals} SET stage='lost', lost_reason='price' WHERE id=$1`, [deal.id])
    const after = (await templates.readTables(id, 'crm')) as unknown as CrmData
    expect(after.deals.find((d) => d.id === won.id)!.probability).toBe(100)
    expect(after.deals.find((d) => d.id === deal.id)).toMatchObject({ stage: 'lost', probability: 0, closed_on: await today(), lost_reason: 'price' })
    const chain = after.deal_stage_history.filter((h) => h.deal_id === deal.id).sort((a, b) => a.changed_at.localeCompare(b.changed_at))
    expect(chain[chain.length - 1]).toMatchObject({ from_stage: 'proposal', to_stage: 'lost' })
    expect(after.deal_stage_history.length).toBe(data.deal_stage_history.length + 1)
    // Deleting a deal takes its history and activities with it, and nothing else.
    await raw(`DELETE FROM {deals} WHERE id=$1`, [deal.id])
    const gone = (await templates.readTables(id, 'crm')) as unknown as CrmData
    expect(gone.deal_stage_history.some((h) => h.deal_id === deal.id)).toBe(false)
    expect(gone.activities.some((a) => a.deal_id === deal.id)).toBe(false)
    expect(gone.deals).toHaveLength(data.deals.length - 1)
  })

  test('the gallery demo is read-only and reads numbers', async () => {
    const demoId = await templates.ensureDemo('crm')
    expect(demoId).toBe('templatecrmv1')
    const demo = (await templates.readTables(demoId, 'crm')) as unknown as CrmData
    expect(demo.readOnly).toBe(true)
    expect(demo.deals).toHaveLength(35)
    for (const d of demo.deals) {
      expect(typeof d.amount_cents).toBe('number')
      expect(typeof d.probability).toBe('number')
    }
    expect(typeof demo.deals[0].created_at).toBe('string')
    await expect(asProject(demoId, (c, t) => c.query(`UPDATE ${t('deals')} SET stage='won'`))).rejects.toThrow()
    const role = await roles.ensureWorkspaceRole(demoId)
    const move = crmStatement({ action: 'move-deal', id: demo.deals[0].id, from: demo.deals[0].stage, to: 'won' })
    // Refused before it reaches the table: the demo has no owner account, and its role may only SELECT.
    await expect(sql.run(role, schemaFor(demoId), move.sql, move.params)).rejects.toThrow()
    expect((await sql.run(role, schemaFor(demoId), crmReads[2].sql)).rows).toHaveLength(35)
  })
})
