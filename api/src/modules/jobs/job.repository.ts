import { LimitsService } from '../limits/limits.service'
import { generationPriority } from '@lovbase/core/entitlements'
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
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService, private readonly limits: LimitsService) {}

  async createTurn(input: {
    requestId: string; projectId: string; appId: string; userId: string; turn: TurnJobInput
  }, beforeCreate?: (client: pg.PoolClient, jobId: string) => Promise<void>): Promise<{ job: JobRow; created: boolean }> {
    await this.schema.ready()
    const existing = await this.byRequest(input.requestId)
    if (existing) {
      this.assertSameRequest(existing, input)
      return { job: existing, created: false }
    }

    const client = await this.pool.connect()
    const id = 'j' + randomId(15)
    const runId = 'r' + randomId(15)
    const priority = generationPriority((await this.limits.plan(input.userId)).id,Date.now())
    const messages = dropEmptyTurns(input.turn.messages) as TurnJobInput['messages']
    const turn = { ...input.turn, messages }
    try {
      await client.query('BEGIN')
      if (beforeCreate) await beforeCreate(client, id)
      const queued = await client.query(
        `SELECT count(*)::int AS n FROM public.lb_jobs
          WHERE user_id = $1 AND status IN ('queued', 'waiting_capacity')`, [input.userId])
      if ((queued.rows[0]?.n ?? 0) >= 3) throw new TooManyRequests('You already have three queued tasks')

      if (!turn.operation) await client.query(
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
          (id, request_id, run_id, project_id, app_id, user_id, status, input, priority)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8) RETURNING *`,
        [id, input.requestId, runId, input.projectId, input.appId, input.userId, JSON.stringify(turn),priority])
      await client.query('COMMIT')
      return { job: result.rows[0] as JobRow, created: true }
    } catch (error) {
      await client.query('ROLLBACK')
      if ((error as { code?: string }).code === '23505') {
        const duplicate = await this.byRequest(input.requestId)
        if (duplicate) {
          this.assertSameRequest(duplicate, input)
          return { job: duplicate, created: false }
        }
        throw new ActiveProjectJob()
      }
      throw error
    } finally {
      client.release()
    }
  }

  private assertSameRequest(job: JobRow, input: { userId: string; projectId: string; appId: string; turn: TurnJobInput }) {
    if (job.user_id !== input.userId || job.project_id !== input.projectId || job.app_id !== input.appId
      || job.input.fingerprint !== input.turn.fingerprint)
      throw new DomainError('requestId was already used with different parameters')
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
          WHERE ahead.status IN ('queued','waiting_capacity') AND (ahead.priority < j.priority OR (ahead.priority=j.priority AND (ahead.created_at, ahead.id) < (j.created_at, j.id)))
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

  async priorityFor(id: string) {
    const row = await this.get(id)
    if (!row) return 2
    const priority = generationPriority((await this.limits.plan(row.user_id)).id,new Date(row.created_at).getTime())
    await this.pool.query('UPDATE public.lb_jobs SET priority=$2 WHERE id=$1',[id,priority])
    return priority
  }
  async waiting() {
    const r=await this.pool.query("SELECT id FROM public.lb_jobs WHERE status IN ('queued','waiting_capacity','starting')")
    return r.rows as {id:string}[]
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

  async finish(id: string, status: 'succeeded' | 'cancelled' | 'failed' | 'interrupted', error?: string, result?: Record<string, unknown>) {
    await this.pool.query(
      `UPDATE public.lb_jobs SET status = $2, error = $3,
         result = coalesce($4::jsonb, '{}'::jsonb) || CASE
           WHEN $2 IN ('failed','interrupted') THEN '{"notification":"failed"}'::jsonb
           WHEN $2 = 'succeeded' AND ($4::jsonb->>'appGenerated' = 'true' OR input->>'operation' IN ('build','publish'))
             THEN '{"notification":"completed"}'::jsonb ELSE '{}'::jsonb END,
         finished_at = now(), updated_at = now()
       WHERE id = $1 AND status NOT IN ('succeeded','cancelled','failed','interrupted')`,
      [id, status, error?.slice(0, 4000) ?? null, result ? JSON.stringify(result) : null])
    await this.pool.query(
      `UPDATE public.lb_runs SET finished_at = coalesce(finished_at, now()), progress = NULL
       WHERE id = (SELECT run_id FROM public.lb_jobs WHERE id = $1)`, [id])
  }

  /** Only terminal results created by the notification-aware worker enter this feed. */
  async notifications(userId: string) {
    await this.schema.ready()
    const result = await this.pool.query(`SELECT j.id,j.project_id AS "projectId",j.app_id AS "appId",
      a.name AS "appName",p.name AS "projectName",j.result->>'notification' AS kind,
      j.finished_at AS "finishedAt"
      FROM public.lb_jobs j JOIN public.lb_apps a ON a.id=j.app_id JOIN public.lb_projects p ON p.id=j.project_id
      WHERE j.user_id=$1 AND p.owner_id=$1 AND j.notification_read_at IS NULL
        AND j.result->>'notification' IN ('completed','failed')
      ORDER BY j.finished_at DESC,j.id DESC LIMIT 20`, [userId])
    return result.rows as { id: string; projectId: string; appId: string; appName: string; projectName: string; kind: 'completed' | 'failed'; finishedAt: string }[]
  }

  async readNotifications(userId: string, ids: string[]) {
    await this.schema.ready()
    await this.pool.query('UPDATE public.lb_jobs SET notification_read_at=now() WHERE user_id=$1 AND id=ANY($2::text[])', [userId, ids])
  }

  async requestCancel(projectId: string, jobId?: string): Promise<JobRow | null> {
    const active = await this.activeForProject(projectId)
    if (active?.input.operation && (!jobId || active.id === jobId) && ['running','finalizing'].includes(active.status))
      throw new DomainError('This application operation is already executing and cannot be cancelled')
    const result = await this.pool.query(
      `UPDATE public.lb_jobs SET cancel_requested_at = coalesce(cancel_requested_at, now()),
         status = CASE WHEN status IN ('queued','waiting_capacity') THEN 'cancelled' ELSE 'cancelling' END,
         finished_at = CASE WHEN status IN ('queued','waiting_capacity') THEN now() ELSE finished_at END,
         updated_at = now()
       WHERE id = (SELECT id FROM public.lb_jobs WHERE project_id = $1 AND ($2::text IS NULL OR id=$2)
         AND status IN ('queued','waiting_capacity','starting','running','finalizing')
         ORDER BY created_at DESC LIMIT 1)
       AND (input->>'operation' IS NULL OR status IN ('queued','waiting_capacity','starting'))
       RETURNING *`, [projectId, jobId ?? null])
    const job = (result.rows[0] as JobRow) ?? null
    if (!job && active?.input.operation && (!jobId || active.id === jobId))
      throw new DomainError('This application operation is already executing and cannot be cancelled')
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
