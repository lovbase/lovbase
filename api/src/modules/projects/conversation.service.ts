import { Injectable, Logger } from '@nestjs/common'
import type pg from 'pg'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { randomId } from '../../common/ids'

export type RunProgress = { text: string; steps: { tool: string; done: boolean }[] }

/**
 * When an unfinished run stops being believed.
 *
 * A row is closed on both the finish and the error path, but a process killed mid-turn leaves one
 * open for ever, and a stale row locks everyone out of a resource that is actually free. So the
 * age bound is the backstop — and it has to sit *past* the build budget, or a task still inside
 * its allowance gets written off as dead while it is plainly working. Five minutes of margin.
 */
const RUN_STALE_AFTER = '35 minutes'
/**
 * How long a run is believed after it last said it was alive. The runner touches its row every
 * ten seconds; a row nobody has touched for this long belongs to a process that is gone, whatever
 * its `finished_at` says — and the reader waiting on it deserves to be told, not to time out.
 */
const RUN_QUIET_AFTER = '2 minutes'
/** Alive: not closed, within budget, and heard from lately (rows from before `touched_at` count from their start). */
const live = (stale: string, quiet: string) =>
  `finished_at IS NULL AND started_at > now() - ${stale}::interval AND coalesce(touched_at, started_at) > now() - ${quiet}::interval`

/**
 * A turn that produced nothing is not a turn. An aborted or failed one still reaches `onFinish` as
 * an assistant message with no parts, and a message with no parts renders as nothing at all — so
 * the transcript shows the user speaking twice in a row, which reads as the same message sent
 * twice. Filtering on the way in also repairs transcripts that already have them, since a save
 * rewrites the whole array.
 */
/**
 * Close the tool calls a turn never finished.
 *
 * A turn cut short by its process dying leaves its last tool call open in the transcript — a
 * spinner with nothing behind it, and a message a model cannot be asked to continue from. Marked
 * as errored with a reason, it renders as what it was, and the next turn can be built on it.
 * Only the last assistant message: that is the only one a live turn could have been writing.
 */
export function sealOpenTools(messages: unknown[], reason: string): { messages: unknown[]; sealed: number } {
  const last = messages[messages.length - 1] as { role?: string; parts?: any[] } | undefined
  if (!last || last.role !== 'assistant' || !Array.isArray(last.parts)) return { messages, sealed: 0 }
  let sealed = 0
  const parts = last.parts.map((p) => {
    // A sentence that was still being typed: what it says is what there is.
    if ((p?.type === 'text' || p?.type === 'reasoning') && p.state === 'streaming') { sealed++; return { ...p, state: 'done' } }
    const isTool = typeof p?.type === 'string' && (p.type.startsWith('tool-') || p.type === 'dynamic-tool')
    if (!isTool || p.state === 'output-available' || p.state === 'output-error') return p
    sealed++
    return { ...p, state: 'output-error', errorText: reason }
  })
  if (!sealed) return { messages, sealed }
  return { messages: [...messages.slice(0, -1), { ...last, parts }], sealed }
}

export const dropEmptyTurns = (messages: unknown[]): unknown[] =>
  messages.filter((m) => {
    const parts = (m as { parts?: unknown })?.parts
    if (!Array.isArray(parts)) return true
    // Saved as it ran, a turn can hold a step marker and an empty sentence before the model has
    // said anything; that is as empty as no parts at all.
    return parts.some((p: any) => p?.type !== 'step-start' && !(p?.type === 'text' && !String(p.text ?? '').trim()))
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
   * How many turns are holding a container right now, this project aside.
   *
   * Builds, not turns. The cap exists because containers are capped, and counting every streaming
   * turn spent the allowance on turns that never ask for one: two people asking how many rows a
   * table has would refuse a third person a build, and tell them too many apps were building. A
   * run counts only once its progress reports an `edit_app` step that has not finished — which is
   * exactly the window it occupies a container for.
   *
   * Bounded by age as well as by `finished_at` — see `RUN_STALE_AFTER`.
   */
  async activeBuilds(exceptProjectId: string, olderThan = RUN_STALE_AFTER): Promise<number> {
    await this.schema.ready()
    const r = await this.pool.query(
      `SELECT count(*)::int AS n FROM public.lb_runs
        WHERE ${live('$2', '$4')} AND project_id <> $1 AND progress @> $3::jsonb`,
      [exceptProjectId, olderThan, JSON.stringify({ steps: [{ tool: 'edit_app', done: false }] }), RUN_QUIET_AFTER])
    return r.rows[0]?.n ?? 0
  }

  /**
   * Open a run and name it. The name is what its recorded stream is filed under, so a reload can
   * ask for this turn rather than whatever the project is doing by the time it asks.
   */
  async startRun(projectId: string): Promise<string> {
    const id = 'r' + randomId(11)
    await this.pool.query(
      `INSERT INTO public.lb_runs (project_id, id, started_at, finished_at) VALUES ($1, $2, now(), NULL)
       ON CONFLICT (project_id) DO UPDATE SET id = $2, started_at = now(), finished_at = NULL`,
      [projectId, id])
    return id
  }

  /** Whether this exact run is still going — the signal that ends a replay. */
  async runLive(runId: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM public.lb_runs WHERE id = $1 AND ${live('$2', '$3')}`,
      [runId, RUN_STALE_AFTER, RUN_QUIET_AFTER])
    return r.rowCount! > 0
  }

  /** The process running this turn is still here. */
  async touchRun(runId: string) {
    try { await this.pool.query(`UPDATE public.lb_runs SET touched_at = now() WHERE id = $1`, [runId]) }
    catch (err) { this.log.error(`touch failed: ${err instanceof Error ? err.message : String(err)}`) }
  }

  async endRun(projectId: string) {
    await this.pool.query(`UPDATE public.lb_runs SET finished_at = now(), progress = NULL WHERE project_id = $1`, [projectId])
  }

  /** Close what a turn left open in the transcript. See `sealOpenTools`. */
  async sealChat(projectId: string, reason: string) {
    const { messages, sealed } = sealOpenTools(await this.getChat(projectId), reason)
    if (sealed) await this.saveChat(projectId, messages)
  }

  /** Written after every agent step so a reconnecting browser has something real to show. */
  async saveProgress(projectId: string, progress: RunProgress) {
    try {
      await this.pool.query(`UPDATE public.lb_runs SET progress = $2 WHERE project_id = $1`, [projectId, JSON.stringify(progress)])
    } catch (err) {
      this.log.error(`progress write failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * The run in flight for this project, if there is one: when it began and what it last reported.
   *
   * One query for both, and `started_at` is the part that was missing. A turn's assistant message
   * is only saved once it finishes, so a browser that reloads mid-build has nothing in the
   * transcript to say a build is running — this row is the only record, and without the start
   * time a resumed clock could only count from the reload, which reads as a build that just began.
   */
  async liveRun(projectId: string): Promise<{ id: string | null; startedAt: number; progress: RunProgress | null } | null> {
    await this.schema.ready()
    const r = await this.pool.query(
      `SELECT id, started_at, progress, (${live('$2', '$3')}) AS alive FROM public.lb_runs
        WHERE project_id = $1 AND finished_at IS NULL`,
      [projectId, RUN_STALE_AFTER, RUN_QUIET_AFTER])
    const row = r.rows[0]
    if (!row) return null
    // Open, but nobody has touched it in a while: the process that ran it is gone. Close it
    // here, where the question was asked, so the page gets an answer instead of a wait — and
    // so the transcript's last step says it stopped rather than spinning for ever.
    if (!row.alive) {
      this.log.warn(`run ${row.id} of ${projectId} went quiet; closing it`)
      await this.sealChat(projectId, '服务重启,这一步中断了')
      await this.endRun(projectId)
      return null
    }
    return { id: row.id ?? null, startedAt: new Date(row.started_at).getTime(), progress: (row.progress as RunProgress) ?? null }
  }
}
