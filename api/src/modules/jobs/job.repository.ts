import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { DomainError, TooManyRequests } from '../../common/errors'
import { randomId } from '../../common/ids'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import type { JobRow, JobState, TurnJobInput } from './job.types'
import { dropEmptyTurns } from '../projects/conversation.service'

export class ActiveProjectJob extends DomainError {
  readonly status = 409
  constructor() { super('A task for this project is already queued or running') }
}

@Injectable()
export class JobRepository {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService) {}

  async createTurn(input: {
    requestId: string; projectId: string; appId: string; userId: string; turn: TurnJobInput
  }): Promise<{ job: JobRow; created: boolean }> {
    await this.schema.ready()
    const existing = await this.byRequest(input.requestId)
    if (existing) return { job: existing, created: false }

    const client = await this.pool.connect()
    const id = 'j' + randomId(15)
    const runId = 'r' + randomId(15)
    const messages = dropEmptyTurns(input.turn.messages) as TurnJobInput['messages']
    const turn = { ...input.turn, messages }
    try {
      await client.query('BEGIN')
      const queued = await client.query(
        `SELECT count(*)::int AS n FROM public.lb_jobs
          WHERE user_id = $1 AND status IN ('queued', 'waiting_capacity')`, [input.userId])
      if ((queued.rows[0]?.n ?? 0) >= 3) throw new TooManyRequests('You already have three queued tasks')

      await client.query(
        `INSERT INTO public.lb_chat (project_id, messages) VALUES ($1, $2)
         ON CONFLICT (project_id) DO UPDATE SET messages = EXCLUDED.messages, updated_at = now()`,
        [input.projectId, JSON.stringify(messages.slice(-200))])
      await client.query(
        `INSERT INTO public.lb_runs (project_id, id, started_at, touched_at, finished_at, progress)
         VALUES ($1, $2, now(), now(), NULL, NULL)
         ON CONFLICT (project_id) DO UPDATE SET id = EXCLUDED.id, started_at = now(),
           touched_at = now(), finished_at = NULL, progress = NULL`, [input.projectId, runId])
      const result = await client.query(
        `INSERT INTO public.lb_jobs
          (id, request_id, run_id, project_id, app_id, user_id, status, input)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7) RETURNING *`,
        [id, input.requestId, runId, input.projectId, input.appId, input.userId, JSON.stringify(turn)])
      await client.query('COMMIT')
      return { job: result.rows[0] as JobRow, created: true }
    } catch (error) {
      await client.query('ROLLBACK')
      if ((error as { code?: string }).code === '23505') {
        const duplicate = await this.byRequest(input.requestId)
        if (duplicate) return { job: duplicate, created: false }
        throw new ActiveProjectJob()
      }
      throw error
    } finally {
      client.release()
    }
  }

  async byRequest(requestId: string): Promise<JobRow | null> {
    const result = await this.pool.query(`SELECT * FROM public.lb_jobs WHERE request_id = $1`, [requestId])
    return (result.rows[0] as JobRow) ?? null
  }

  async get(id: string): Promise<JobRow | null> {
    await this.schema.ready()
    const result = await this.pool.query(`SELECT * FROM public.lb_jobs WHERE id = $1`, [id])
    return (result.rows[0] as JobRow) ?? null
  }

  async activeForProject(projectId: string): Promise<JobRow | null> {
    await this.schema.ready()
    const result = await this.pool.query(
      `SELECT * FROM public.lb_jobs WHERE project_id = $1
       AND status IN ('queued','waiting_capacity','starting','running','finalizing','cancelling')
       ORDER BY created_at DESC LIMIT 1`, [projectId])
    return (result.rows[0] as JobRow) ?? null
  }

  async stateForProject(projectId: string): Promise<JobState | null> {
    await this.schema.ready()
    const result = await this.pool.query(
      `SELECT j.*, CASE WHEN j.status IN ('queued','waiting_capacity') THEN (
         SELECT count(*)::int FROM public.lb_jobs ahead
          WHERE ahead.status IN ('queued','waiting_capacity') AND ahead.created_at < j.created_at
       ) ELSE NULL END AS queue_position
       FROM public.lb_jobs j WHERE j.project_id = $1
         AND (j.finished_at IS NULL OR j.finished_at > now() - interval '24 hours')
       ORDER BY j.created_at DESC LIMIT 1`, [projectId])
    const job = result.rows[0] as (JobRow & { queue_position: number | null }) | undefined
    if (!job) return null
    return {
      id: job.id, runId: job.run_id, status: job.status,
      createdAt: new Date(job.created_at).getTime(),
      startedAt: job.started_at ? new Date(job.started_at).getTime() : null,
      cancelRequested: !!job.cancel_requested_at,
      queuePosition: job.queue_position,
    }
  }

  async runActive(runId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM public.lb_jobs WHERE run_id = $1
       AND status IN ('queued','waiting_capacity','starting','running','finalizing','cancelling')`, [runId])
    return result.rowCount === 1
  }

  /** User-facing reason for a run that ended before its Redis stream was created. */
  async terminalErrorForRun(runId: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT status, error FROM public.lb_jobs WHERE run_id = $1`, [runId])
    const job = result.rows[0] as Pick<JobRow, 'status' | 'error'> | undefined
    if (!job) return null
    if (job.status === 'failed') return job.error || 'Task failed before output started'
    if (job.status === 'interrupted') return job.error || 'Task was interrupted before output started'
    if (job.status === 'cancelled') return 'Task was cancelled'
    return null
  }

  async claim(id: string, workerId: string): Promise<JobRow | null> {
    const result = await this.pool.query(
      `UPDATE public.lb_jobs SET status = 'starting', worker_id = $2, attempt = attempt + 1,
         started_at = coalesce(started_at, now()), updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'waiting_capacity') AND cancel_requested_at IS NULL
       RETURNING *`, [id, workerId])
    return (result.rows[0] as JobRow) ?? null
  }

  /** BullMQ only redelivers an active job after its lock was lost. Never rerun its side effects. */
  async interruptRedelivery(id: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE public.lb_jobs SET status = 'interrupted', error = 'Worker lock was lost',
         finished_at = now(), updated_at = now()
       WHERE id = $1 AND worker_id IS DISTINCT FROM $2
         AND status IN ('starting','running','finalizing') RETURNING run_id`, [id, workerId])
    const runId = result.rows[0]?.run_id
    if (runId) await this.pool.query(
      `UPDATE public.lb_runs SET finished_at = now(), progress = NULL WHERE id = $1`, [runId])
    return result.rowCount === 1
  }

  async markRunning(id: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE public.lb_jobs SET status = 'running', updated_at = now()
       WHERE id = $1 AND worker_id = $2 AND status IN ('starting','waiting_capacity') AND cancel_requested_at IS NULL`,
      [id, workerId])
    return result.rowCount === 1
  }

  async markWaitingCapacity(id: string, workerId: string) {
    await this.pool.query(
      `UPDATE public.lb_jobs SET status = 'waiting_capacity', updated_at = now()
       WHERE id = $1 AND worker_id = $2 AND status IN ('starting','waiting_capacity')
         AND cancel_requested_at IS NULL`, [id, workerId])
  }

  async markFinalizing(id: string, workerId: string) {
    await this.pool.query(
      `UPDATE public.lb_jobs SET status = 'finalizing', updated_at = now()
       WHERE id = $1 AND worker_id = $2 AND status = 'running'`, [id, workerId])
  }

  async finish(id: string, status: 'succeeded' | 'cancelled' | 'failed' | 'interrupted', error?: string) {
    await this.pool.query(
      `UPDATE public.lb_jobs SET status = $2, error = $3, finished_at = now(), updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded','cancelled','failed','interrupted')`,
      [id, status, error?.slice(0, 4000) ?? null])
    await this.pool.query(
      `UPDATE public.lb_runs SET finished_at = coalesce(finished_at, now()), progress = NULL
       WHERE id = (SELECT run_id FROM public.lb_jobs WHERE id = $1)`, [id])
  }

  async requestCancel(projectId: string): Promise<JobRow | null> {
    const result = await this.pool.query(
      `UPDATE public.lb_jobs SET cancel_requested_at = coalesce(cancel_requested_at, now()),
         status = CASE WHEN status IN ('queued','waiting_capacity') THEN 'cancelled' ELSE 'cancelling' END,
         finished_at = CASE WHEN status IN ('queued','waiting_capacity') THEN now() ELSE finished_at END,
         updated_at = now()
       WHERE id = (SELECT id FROM public.lb_jobs WHERE project_id = $1
         AND status IN ('queued','waiting_capacity','starting','running','finalizing')
         ORDER BY created_at DESC LIMIT 1)
       RETURNING *`, [projectId])
    const job = (result.rows[0] as JobRow) ?? null
    if (job?.status === 'cancelled') {
      await this.pool.query(`UPDATE public.lb_runs SET finished_at = now(), progress = NULL WHERE id = $1`, [job.run_id])
    }
    return job
  }

  async cancelRequested(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT cancel_requested_at IS NOT NULL OR status IN ('cancelling','cancelled') AS cancel
       FROM public.lb_jobs WHERE id = $1`, [id])
    return result.rows[0]?.cancel ?? true
  }

  async unenqueued(limit = 100): Promise<JobRow[]> {
    await this.schema.ready()
    const result = await this.pool.query(
      `SELECT * FROM public.lb_jobs WHERE status = 'queued' AND enqueued_at IS NULL
       ORDER BY created_at ASC LIMIT $1`, [limit])
    return result.rows as JobRow[]
  }

  async markEnqueued(id: string) {
    await this.pool.query(
      `UPDATE public.lb_jobs SET enqueued_at = coalesce(enqueued_at, now()), updated_at = now()
       WHERE id = $1 AND status = 'queued'`, [id])
  }
}
