import 'reflect-metadata'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { JobRepository } from '../src/modules/jobs/job.repository'
import { JobQueueService } from '../src/modules/jobs/job-queue.service'
import { TurnService } from '../src/modules/agent/turn.service'

const db = new PGlite()
const query = async (sql: string, params?: unknown[]) => {
  const result = await db.query(sql, params)
  return { rows: result.rows, rowCount: result.affectedRows || result.rows.length }
}
const jobs = new JobRepository({ query } as any, { ready: async () => {} } as any, {} as any)
beforeAll(async () => {
  await db.exec(`CREATE TABLE lb_jobs (
    id text PRIMARY KEY, project_id text, run_id text, input jsonb, status text,
    worker_id text, started_at timestamptz, enqueued_at timestamptz,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    finished_at timestamptz, cancel_requested_at timestamptz, error text, result jsonb);
    CREATE UNIQUE INDEX active_project ON lb_jobs(project_id)
      WHERE status IN ('queued','waiting_capacity','starting','running','finalizing');
    CREATE TABLE lb_runs (id text PRIMARY KEY, finished_at timestamptz, progress jsonb);`)
}, 30000)
afterAll(() => db.close())

test('reconcile frees projects after terminal queue delivery without touching live, waiting, or missing deliveries', async () => {
  const states = ['completed', 'failed', 'active', 'waiting', 'delayed', 'prioritized', 'missing']
  for (const state of states) {
    await query(`INSERT INTO lb_jobs(id,project_id,run_id,input,status,worker_id,started_at)
      VALUES($1,$1,$1,'{}','running','container:2',now())`, [state])
    await query('INSERT INTO lb_runs(id) VALUES($1)', [state])
  }
  await query(`INSERT INTO lb_jobs(id,project_id,run_id,input,status,started_at,cancel_requested_at)
    VALUES('cancel','cancel','cancel','{"operation":"publish"}','cancelling',now(),now())`)
  const queue = Object.create(JobQueueService.prototype) as any
  Object.assign(queue, { jobs,
    turns: { getJob: async (id: string) => id === 'missing' ? undefined : { getState: async () => id } },
    operations: { getJob: async () => ({ getState: async () => 'completed' }) },
  })
  await queue.reconcile()
  for (const state of states) {
    expect((await jobs.get(state))?.status).toBe(['completed','failed'].includes(state) ? 'interrupted' : 'running')
  }
  expect((await jobs.get('cancel'))?.status).toBe('cancelled')
  expect((await query("SELECT finished_at FROM lb_runs WHERE id='completed'")).rows[0].finished_at).toBeTruthy()
  // The unique project guard now permits a new publish, while the old job is never replayed.
  await query(`INSERT INTO lb_jobs(id,project_id,run_id,input,status,enqueued_at)
    VALUES('publish','completed','publish','{"operation":"publish"}','queued',now())`)
  await queue.reconcile()
  expect((await jobs.get('publish'))?.status).toBe('queued')
  expect((await jobs.get('completed'))?.result).toMatchObject({ notification: 'failed' })
})

test('redelivery with a fresh process identity interrupts the dead run and preserves terminal results', async () => {
  await query(`INSERT INTO lb_jobs(id,project_id,run_id,input,status,worker_id,started_at)
    VALUES('restart','restart','restart','{}','running','container:2:old',now())`)
  await query("INSERT INTO lb_runs(id) VALUES('restart')")
  expect(await jobs.interruptRedelivery('restart', 'container:2:new')).toBe(true)
  expect((await jobs.get('restart'))?.status).toBe('interrupted')
  expect(await jobs.interruptRedelivery('restart', 'container:2:third')).toBe(false)
})

test('transcript reader drains SDK output after final save without cancelling or saving late chunks', async () => {
  let controller!: ReadableStreamDefaultController<any>
  let final = false, saves = 0
  const stream = new ReadableStream({ start(c) { controller = c } })
  const service = new TurnService({} as any, {} as any, {} as any, {} as any)
  const reading = (service as any).persist(stream, [], async () => { saves++ }, () => final)
  controller.enqueue({ type: 'start', messageId: 'message' })
  controller.enqueue({ type: 'text-start', id: 'text' })
  controller.enqueue({ type: 'text-delta', id: 'text', delta: 'before' })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(saves).toBeGreaterThan(0)
  const saved = saves
  final = true
  controller.enqueue({ type: 'text-delta', id: 'text', delta: 'after' })
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.enqueue({ type: 'text-end', id: 'text' })
  controller.enqueue({ type: 'finish' })
  controller.close()
  await reading
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(saves).toBe(saved)
})
