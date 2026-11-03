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
  errorCode,
  pipeline,
  readStatements,
  recruitingTables,
  statementFor,
  timelines,
  type RecruitingAction,
  type RecruitingData,
} from '@lovbase/core/recruiting'

const url = process.env.TEMPLATE_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
suite('Recruiting template on PostgreSQL', () => {
  const pool = new Pool({ connectionString: url })
  const schema = new SchemaService(pool)
  const cfg = ConfigService.of({ DATABASE_URL: url, SQL_ROLE_PASSWORD: 'templates-sql-test' })
  const roles = new RolesService(pool, cfg)
  const limits = new LimitsService(pool, cfg, schema)
  const templates = new TemplatesService(pool, schema, roles, limits)
  const projects = new ProjectsService(pool, schema, roles, limits)
  const sql = new SqlService(pool, pool, limits)
  const users: string[] = []
  const ids = new Set<string>()
  const read = (id: string) => templates.readTables(id, 'recruiting') as Promise<unknown> as Promise<RecruitingData>
  async function fixture() {
    const userId = `recruiting-test-${randomUUID()}`
    users.push(userId)
    await pool.query(
      'INSERT INTO public."user"(id,name,email,plan,"createdAt","updatedAt") VALUES($1,$1,$2,\'pro\',now(),now())',
      [userId, `${userId}@example.invalid`],
    )
    const created = await templates.create(userId, {
      templateId: 'recruiting',
      version: 1,
      name: 'Recruiting test',
      locale: 'en',
      requestId: randomUUID(),
    })
    ids.add(created.projectId)
    return { id: created.projectId, data: await read(created.projectId) }
  }
  // The copy's client path: the statement from core, through the SQL API service, as the workspace role.
  async function run(id: string, action: RecruitingAction) {
    const statement = statementFor(action)
    const role = await roles.ensureWorkspaceRole(id)
    const result = await sql.run(role, schemaFor(id), statement.sql, statement.params).catch((error: Error) => {
      throw new Error(errorCode(error.message))
    })
    if (statement.one && result.rows.length !== 1) throw new Error('record_unavailable')
    return result
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
  /** A fresh open job with `seats` seats and `people` applicants waiting at the offer stage. */
  async function openJob(id: string, seats: number, people: number) {
    const jobId = randomUUID()
    await run(id, { action: 'create-job', id: jobId, status: 'open', title: 'QA Engineer', title_en: '', department: 'Engineering', location: 'Remote', employment: 'full_time', headcount: seats })
    const applications: string[] = []
    for (let i = 0; i < people; i++) {
      const candidateId = randomUUID()
      const applicationId = randomUUID()
      await run(id, { action: 'add-candidate', id: candidateId, name: `Test ${i}`, email: `${candidateId}@example.invalid`, phone: '', source: 'website', current_title: '', notes: '' })
      await run(id, { action: 'apply', id: applicationId, jobId, candidateId, appliedOn: '2026-10-01' })
      let from: (typeof pipeline)[number] = 'applied'
      for (const to of ['screening', 'interview', 'offer'] as const) {
        await run(id, { action: 'move', id: applicationId, from, to })
        from = to
      }
      applications.push(applicationId)
    }
    return { jobId, applications }
  }
  const hire = (c: PoolClient, table: (n: string) => string, applicationId: string) =>
    c.query(`UPDATE ${table('applications')} SET stage = 'hired' WHERE id = $1`, [applicationId])

  beforeAll(() => schema.ready(), 30000)
  afterAll(async () => {
    for (const id of ids) await projects.remove(id)
    for (const id of users) await pool.query('DELETE FROM public."user" WHERE id=$1', [id])
    await pool.end()
  })

  test('seeded pipeline is consistent: histories chain, seats hold, one job filled and closed', async () => {
    const { data } = await fixture()
    expect(data.readOnly).toBe(false)
    expect(data.jobs.length).toBeGreaterThanOrEqual(6)
    expect(data.candidates.length).toBeGreaterThanOrEqual(65)
    expect(data.applications.length).toBeGreaterThanOrEqual(85)
    expect(data.interviews.length).toBeGreaterThan(40)
    expect(typeof data.jobs[0].headcount).toBe('number')
    expect(data.applications.some((a) => typeof a.rating === 'number')).toBe(true)
    expect(data.interviews.some((i) => typeof i.score === 'number')).toBe(true)
    expect(data.stage_events[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    expect(new Set(data.applications.map((a) => a.stage))).toEqual(new Set(['applied', 'screening', 'interview', 'offer', 'hired', 'rejected']))
    for (const job of data.jobs) {
      const hired = data.applications.filter((a) => a.job_id === job.id && a.stage === 'hired').length
      expect(hired).toBeLessThanOrEqual(job.headcount)
      if (hired === job.headcount) expect(job.status).toBe('closed')
    }
    const closed = data.jobs.filter((j) => j.status === 'closed')
    expect(closed).toHaveLength(1)
    expect(data.applications.filter((a) => a.job_id === closed[0].id && a.stage === 'hired')).toHaveLength(closed[0].headcount)
    expect(data.jobs.map((j) => j.status).sort()).toEqual(['closed', 'draft', 'open', 'open', 'open', 'open', 'paused'])
    // Every history starts at "applied", each step leaves where the last one arrived, and the
    // application's stage and stamp are those of its latest step.
    const history = timelines(data.stage_events)
    const threeMonths = Date.now() - 100 * 86_400_000
    for (const a of data.applications) {
      const events = history.get(a.id)!
      expect(events[0].from_stage).toBeNull()
      expect(events[0].to_stage).toBe('applied')
      for (let i = 1; i < events.length; i++) {
        expect(events[i].from_stage).toBe(events[i - 1].to_stage)
        expect(events[i].at >= events[i - 1].at).toBe(true)
      }
      expect(events[events.length - 1].to_stage).toBe(a.stage)
      expect(events[events.length - 1].at).toBe(a.stage_changed_at)
      expect(Date.parse(events[0].at)).toBeGreaterThan(threeMonths)
      expect(Date.parse(a.stage_changed_at)).toBeLessThan(Date.now())
      if (a.stage === 'rejected') expect(a.rejected_reason).toBeTruthy()
    }
    const pairs = data.applications.map((a) => `${a.job_id}:${a.candidate_id}`)
    expect(new Set(pairs).size).toBe(pairs.length)
    expect(data.interviews.some((i) => Date.parse(i.scheduled_at) > Date.now() && i.score === null)).toBe(true)
    expect(data.interviews.some((i) => Date.parse(i.scheduled_at) < Date.now() && i.score === null)).toBe(true)
    expect(data.candidates.every((c) => c.email.endsWith('@example.invalid'))).toBe(true)
  })

  test("the client's statements work through the SQL API and read back what the preview reads", async () => {
    const { id, data } = await fixture()
    const role = await roles.ensureWorkspaceRole(id)
    // Same rows, same types as readTables, once they have been through JSON like an HTTP response.
    const viaSql: Record<string, unknown> = { readOnly: false }
    for (const table of recruitingTables) {
      const result = await sql.run(role, schemaFor(id), readStatements[table])
      viaSql[table] = JSON.parse(JSON.stringify(result.rows))
    }
    expect(viaSql).toEqual(data as unknown as Record<string, unknown>)

    const jobId = randomUUID()
    await run(id, { action: 'create-job', id: jobId, status: 'draft', title: '运维工程师', title_en: 'SRE', department: 'Engineering', location: 'London', employment: 'full_time', headcount: 1 })
    await run(id, { action: 'update-job', id: jobId, title: '运维工程师', title_en: 'Site Reliability Engineer', department: 'Engineering', location: 'London', employment: 'full_time', headcount: 2 })
    const candidateId = randomUUID()
    await run(id, { action: 'add-candidate', id: candidateId, name: 'Rin Aoki', email: 'rin.aoki@example.invalid', phone: '', source: 'referral', current_title: 'SRE', notes: '' })
    await run(id, { action: 'update-candidate', id: candidateId, name: 'Rin Aoki', email: 'rin.aoki@example.invalid', phone: '+1 202 555 0199', source: 'referral', current_title: 'Senior SRE', notes: 'Met at a meetup' })
    // A draft takes no applications; opening it stamps the opening day.
    await expect(run(id, { action: 'apply', id: randomUUID(), jobId, candidateId, appliedOn: '2026-10-02' })).rejects.toThrow('job_not_open')
    await run(id, { action: 'set-job-status', id: jobId, status: 'open' })
    const applicationId = randomUUID()
    await run(id, { action: 'apply', id: applicationId, jobId, candidateId, appliedOn: '2026-10-02' })
    await run(id, { action: 'move', id: applicationId, from: 'applied', to: 'screening' })
    await expect(run(id, { action: 'move', id: applicationId, from: 'applied', to: 'interview' })).rejects.toThrow('record_unavailable')
    await run(id, { action: 'rate', id: applicationId, rating: 4 })
    const interviewId = randomUUID()
    await run(id, { action: 'schedule-interview', id: interviewId, applicationId, kind: 'technical', scheduledAt: new Date().toISOString(), interviewer: 'Daniel Ho' })
    await run(id, { action: 'record-scorecard', id: interviewId, score: 3, recommendation: 'yes', feedback: 'Calm under pressure' })
    await expect(run(id, { action: 'cancel-interview', id: interviewId })).rejects.toThrow('record_unavailable')
    const later = randomUUID()
    await run(id, { action: 'schedule-interview', id: later, applicationId, kind: 'onsite', scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), interviewer: 'Maya Lin' })
    await run(id, { action: 'cancel-interview', id: later })
    await run(id, { action: 'move', id: applicationId, from: 'screening', to: 'rejected', reason: 'withdrew' })
    let after = await read(id)
    const job = after.jobs.find((j) => j.id === jobId)!
    expect(job.status).toBe('open')
    expect(job.opened_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(job.headcount).toBe(2)
    const application = after.applications.find((a) => a.id === applicationId)!
    expect([application.stage, application.rating, application.rejected_reason]).toEqual(['rejected', 4, 'withdrew'])
    expect(after.stage_events.filter((e) => e.application_id === applicationId).map((e) => e.to_stage).sort()).toEqual(['applied', 'rejected', 'screening'])
    expect(after.interviews.filter((i) => i.application_id === applicationId).map((i) => i.score)).toEqual([3])
    // Moving back out of rejected clears the reason; reject-remaining sweeps whoever is left.
    await run(id, { action: 'move', id: applicationId, from: 'rejected', to: 'screening' })
    await run(id, { action: 'reject-remaining', jobId, reason: 'filled' })
    // Removing a person takes their applications and their history with them.
    await run(id, { action: 'delete-candidate', id: candidateId })
    after = await read(id)
    expect(after.applications.some((a) => a.id === applicationId)).toBe(false)
    expect(after.stage_events.some((e) => e.application_id === applicationId)).toBe(false)
    expect(after.interviews.some((i) => i.application_id === applicationId)).toBe(false)
  })

  test('a candidate applies once per job, never to a closed one, with valid values only', async () => {
    const { id, data } = await fixture()
    const open = data.jobs.find((j) => j.status === 'open')!
    const closed = data.jobs.find((j) => j.status === 'closed')!
    const existing = data.applications.find((a) => a.job_id === open.id)!
    const fresh = data.candidates.find((c) => !data.applications.some((a) => a.candidate_id === c.id && (a.job_id === closed.id || a.job_id === open.id)))!
    await expect(run(id, { action: 'apply', id: randomUUID(), jobId: open.id, candidateId: existing.candidate_id, appliedOn: '2026-10-02' })).rejects.toThrow('already_applied')
    await expect(run(id, { action: 'apply', id: randomUUID(), jobId: closed.id, candidateId: fresh.id, appliedOn: '2026-10-02' })).rejects.toThrow('job_not_open')
    await expect(run(id, { action: 'apply', id: randomUUID(), jobId: open.id, candidateId: fresh.id, appliedOn: '2026-02-30' })).rejects.toThrow('invalid_input')
    await expect(run(id, { action: 'add-candidate', id: randomUUID(), name: 'Copy', email: data.candidates[0].email.toUpperCase(), phone: '', source: 'other', current_title: '', notes: '' })).rejects.toThrow('duplicate_email')
    await expect(run(id, { action: 'rate', id: existing.id, rating: 6 })).rejects.toThrow('invalid_input')
    const statements: ((t: (n: string) => string) => string)[] = [
      (t) => `INSERT INTO ${t('candidates')}(name,email,source) VALUES('X','not-an-email','other')`,
      (t) => `INSERT INTO ${t('candidates')}(name,email,source) VALUES('X','x@example.invalid','tiktok')`,
      (t) => `UPDATE ${t('applications')} SET stage='rejected', rejected_reason=' ' WHERE id='${existing.id}'`,
      (t) => `UPDATE ${t('interviews')} SET score=3 WHERE score IS NULL`,
      (t) => `UPDATE ${t('interviews')} SET score=5, recommendation='yes'`,
      (t) => `UPDATE ${t('jobs')} SET opened_on='2026/10/01' WHERE id='${open.id}'`,
      (t) => `UPDATE ${t('jobs')} SET headcount=0 WHERE id='${open.id}'`,
      (t) => `UPDATE ${t('jobs')} SET employment='freelance' WHERE id='${open.id}'`,
    ]
    for (const statement of statements) await expect(asProject(id, (c, t) => c.query(statement(t)))).rejects.toThrow()
    // The pair can't be re-pointed at another job either.
    await expect(asProject(id, (c, t) => c.query(`UPDATE ${t('applications')} SET job_id=$2 WHERE id=$1`, [existing.id, closed.id]))).rejects.toThrow('application_locked')
  })

  test('stage changes are stamped and logged by the database, and the log is its alone', async () => {
    const { id, data } = await fixture()
    const application = data.applications.find((a) => a.stage === 'screening')!
    const stamped = await asProject(id, async (c, t) => {
      await c.query(`UPDATE ${t('applications')} SET stage='interview' WHERE id=$1`, [application.id])
      return (await c.query(`SELECT stage_changed_at, now() AS now FROM ${t('applications')} WHERE id=$1`, [application.id])).rows[0]
    })
    expect(stamped.stage_changed_at.getTime()).toBe(stamped.now.getTime())
    let after = await read(id)
    const events = after.stage_events.filter((e) => e.application_id === application.id)
    expect(events.map((e) => [e.from_stage, e.to_stage]).pop()).toEqual(['screening', 'interview'])
    // A rating edit leaves the clock alone; a backdated move must stay in order and in the past.
    await asProject(id, (c, t) => c.query(`UPDATE ${t('applications')} SET rating=2, stage_changed_at=now() - interval '1 year' WHERE id=$1`, [application.id]))
    after = await read(id)
    expect(after.applications.find((a) => a.id === application.id)!.stage_changed_at).toBe(new Date(stamped.stage_changed_at).toISOString())
    for (const when of [`now() + interval '1 day'`, `now() - interval '1 year'`])
      await expect(
        asProject(id, (c, t) => c.query(`UPDATE ${t('applications')} SET stage='offer', stage_changed_at=${when} WHERE id=$1`, [application.id])),
      ).rejects.toThrow('invalid_stage_time')
    for (const statement of [
      (t: (n: string) => string) => `INSERT INTO ${t('stage_events')}(application_id,to_stage) VALUES('${application.id}','hired')`,
      (t: (n: string) => string) => `UPDATE ${t('stage_events')} SET to_stage='hired' WHERE application_id='${application.id}'`,
      (t: (n: string) => string) => `DELETE FROM ${t('stage_events')} WHERE application_id='${application.id}'`,
    ])
      await expect(asProject(id, (c, t) => c.query(statement(t)))).rejects.toThrow('stage_events_managed')
    expect((await read(id)).stage_events).toHaveLength(after.stage_events.length)
  })

  test('headcount: the last seat closes the job, a hire is final, and seats cannot shrink below hires', async () => {
    const { id } = await fixture()
    const { jobId, applications: [first, second, third] } = await openJob(id, 2, 3)
    await asProject(id, (c, t) => hire(c, t, first))
    let job = (await read(id)).jobs.find((j) => j.id === jobId)!
    expect(job.status).toBe('open')
    await expect(asProject(id, (c, t) => c.query(`UPDATE ${t('jobs')} SET headcount=0 WHERE id=$1`, [jobId]))).rejects.toThrow()
    await asProject(id, (c, t) => hire(c, t, second))
    job = (await read(id)).jobs.find((j) => j.id === jobId)!
    expect(job.status).toBe('closed')
    await expect(asProject(id, (c, t) => hire(c, t, third))).rejects.toThrow('headcount_filled')
    await expect(run(id, { action: 'move', id: first, from: 'hired', to: 'offer' })).rejects.toThrow('hired_is_final')
    await expect(run(id, { action: 'update-job', id: jobId, title: 'QA Engineer', title_en: '', department: 'Engineering', location: 'Remote', employment: 'full_time', headcount: 1 })).rejects.toThrow('headcount_below_hired')
    await expect(run(id, { action: 'set-job-status', id: jobId, status: 'open' })).rejects.toThrow('headcount_filled')
    await expect(run(id, { action: 'set-job-status', id: jobId, status: 'draft' })).rejects.toThrow()
    // One more seat reopens it, and the third person can be hired after all.
    await run(id, { action: 'update-job', id: jobId, title: 'QA Engineer', title_en: '', department: 'Engineering', location: 'Remote', employment: 'full_time', headcount: 3 })
    await run(id, { action: 'set-job-status', id: jobId, status: 'open' })
    await run(id, { action: 'move', id: third, from: 'offer', to: 'hired' })
    const data = await read(id)
    expect(data.jobs.find((j) => j.id === jobId)!.status).toBe('closed')
    expect(data.applications.filter((a) => a.job_id === jobId && a.stage === 'hired')).toHaveLength(3)
  })

  test('two recruiters hiring for the last seat at once: exactly one succeeds', async () => {
    const { id } = await fixture()
    // Deterministic interleaving: the first holds the job row, the second waits on it.
    {
      const { jobId, applications: [a, b] } = await openJob(id, 1, 2)
      const one = await pool.connect()
      await one.query('BEGIN')
      await one.query(`SET LOCAL ROLE "${roleFor(id)}"`)
      await hire(one, (n) => `"${schemaFor(id)}"."${n}"`, a)
      const waiting = asProject(id, (c, t) => hire(c, t, b))
      await new Promise((resolve) => setTimeout(resolve, 300))
      await one.query('COMMIT')
      one.release()
      await expect(waiting).rejects.toThrow('headcount_filled')
      const data = await read(id)
      expect(data.applications.filter((x) => x.job_id === jobId && x.stage === 'hired').map((x) => x.id)).toEqual([a])
    }
    // And a free-for-all through the SQL API: several attempts, one seat, one winner. (The API
    // also serializes an account's writes; the case above is the one that proves the row lock.)
    {
      const { jobId, applications } = await openJob(id, 1, 4)
      const results = await Promise.allSettled(applications.map((a) => run(id, { action: 'move', id: a, from: 'offer', to: 'hired' })))
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toContain('headcount_filled')
      const data = await read(id)
      expect(data.applications.filter((x) => x.job_id === jobId && x.stage === 'hired')).toHaveLength(1)
      expect(data.jobs.find((j) => j.id === jobId)!.status).toBe('closed')
    }
  })

  test('the gallery demo is read-only and its numbers arrive as numbers', async () => {
    const demoId = await templates.ensureDemo('recruiting')
    const demo = await read(demoId)
    expect(demo.readOnly).toBe(true)
    expect(demo.jobs.every((j) => typeof j.headcount === 'number')).toBe(true)
    expect(demo.applications.filter((a) => a.rating !== null).every((a) => typeof a.rating === 'number')).toBe(true)
    expect(demo.interviews.filter((i) => i.score !== null).every((i) => typeof i.score === 'number')).toBe(true)
    await expect(
      asProject(demoId, (c, t) => c.query(`UPDATE ${t('applications')} SET rating = 5`)),
    ).rejects.toThrow()
    await expect(
      asProject(demoId, (c, t) => c.query(`INSERT INTO ${t('candidates')}(name,email,source) VALUES('X','x@example.invalid','other')`)),
    ).rejects.toThrow()
  })
})
