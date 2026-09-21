import { Injectable, Logger } from '@nestjs/common'
import type pg from 'pg'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'

export type RunProgress = { text: string; steps: { tool: string; done: boolean }[] }

/**
 * A turn that produced nothing is not a turn. An aborted or failed one still reaches `onFinish` as
 * an assistant message with no parts, and a message with no parts renders as nothing at all — so
 * the transcript shows the user speaking twice in a row, which reads as the same message sent
 * twice. Filtering on the way in also repairs transcripts that already have them, since a save
 * rewrites the whole array.
 */
export const dropEmptyTurns = (messages: unknown[]): unknown[] =>
  messages.filter((m) => {
    const parts = (m as { parts?: unknown })?.parts
    return !Array.isArray(parts) || parts.length > 0
  })

/**
 * The chat transcript and the "is a turn still running" marker. Both live in Postgres rather than
 * memory so a browser refresh — or a redeploy mid-turn — still shows what is happening.
 */
@Injectable()
export class ConversationService {
  private readonly log = new Logger('conversation')

  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService) {}

  async getChat(projectId: string): Promise<unknown[]> {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT messages FROM public.lb_chat WHERE project_id = $1`, [projectId])
    return (r.rows[0]?.messages as unknown[]) ?? []
  }

  async saveChat(projectId: string, messages: unknown[]) {
    messages = dropEmptyTurns(messages)
    await this.pool.query(
      `INSERT INTO public.lb_chat (project_id, messages) VALUES ($1, $2)
       ON CONFLICT (project_id) DO UPDATE SET messages = $2, updated_at = now()`,
      [projectId, JSON.stringify(messages)])
  }

  async appendChat(projectId: string, messages: unknown[]) {
    const cur = await this.getChat(projectId)
    await this.saveChat(projectId, [...cur, ...messages].slice(-200))
  }

  /** Drop everything from `messageId` onwards, so a user can edit and resend. */
  async truncateChat(projectId: string, messageId: string) {
    const chat = (await this.getChat(projectId)) as { id?: string }[]
    const i = chat.findIndex((m) => m.id === messageId)
    await this.saveChat(projectId, i < 0 ? chat : chat.slice(0, i))
  }

  /**
   * How many turns are streaming right now, this project aside.
   *
   * Bounded by age as well as by `finished_at`: `endRun` is called from both the finish and the
   * error path, but a process killed mid-turn leaves a row open for ever, and a stale row would
   * lock everyone out of a resource that is actually free.
   */
  async activeRuns(exceptProjectId: string, olderThan = '15 minutes'): Promise<number> {
    await this.schema.ready()
    const r = await this.pool.query(
      `SELECT count(*)::int AS n FROM public.lb_runs
        WHERE finished_at IS NULL AND project_id <> $1 AND started_at > now() - $2::interval`,
      [exceptProjectId, olderThan])
    return r.rows[0]?.n ?? 0
  }

  async startRun(projectId: string) {
    await this.pool.query(
      `INSERT INTO public.lb_runs (project_id, started_at, finished_at) VALUES ($1, now(), NULL)
       ON CONFLICT (project_id) DO UPDATE SET started_at = now(), finished_at = NULL`, [projectId])
  }

  async endRun(projectId: string) {
    await this.pool.query(`UPDATE public.lb_runs SET finished_at = now(), progress = NULL WHERE project_id = $1`, [projectId])
  }

  /** Written after every agent step so a reconnecting browser has something real to show. */
  async saveProgress(projectId: string, progress: RunProgress) {
    try {
      await this.pool.query(`UPDATE public.lb_runs SET progress = $2 WHERE project_id = $1`, [projectId, JSON.stringify(progress)])
    } catch (err) {
      this.log.error(`progress write failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async loadProgress(projectId: string): Promise<RunProgress | null> {
    const r = await this.pool.query(`SELECT progress FROM public.lb_runs WHERE project_id = $1 AND finished_at IS NULL`, [projectId])
    return (r.rows[0]?.progress as RunProgress) ?? null
  }

  /** A run counts as live for 15 minutes; past that we assume the worker died mid-turn. */
  async runActive(projectId: string): Promise<boolean> {
    await this.schema.ready()
    const r = await this.pool.query(
      `SELECT 1 FROM public.lb_runs WHERE project_id = $1 AND finished_at IS NULL AND started_at > now() - interval '15 minutes'`,
      [projectId])
    return r.rowCount! > 0
  }
}
