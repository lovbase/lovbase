import { createServerFn } from '@tanstack/react-start'
import { AppsService, ApplyService, ConversationService, JobQueueService, JobRepository, SandboxLeaseService, SandboxService, parseActivity, svc } from '@lovbase/api'
import { requireApp, requireProject } from './_ctx'

/** The saved transcript, for resuming a run after a refresh. */
export const chatState = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    const conversation = await svc(ConversationService)
    const job = await (await svc(JobRepository)).stateForProject(project.id)
    const jobRunning = !!job && ['queued', 'waiting_capacity', 'starting', 'running', 'finalizing', 'cancelling'].includes(job.status)
    const live = jobRunning ? null : await conversation.liveRun(project.id)
    return {
      chat: (await conversation.getChat(project.id)) as any,
      pendingIds: await (await svc(ApplyService)).listPendingIds(project.id),
      running: jobRunning || !!live,
      job,
      progress: live?.progress ?? null,
      // When the turn began, so a reconnecting page can go on counting from there rather than
      // starting a fresh clock at zero and calling a four-minute build five seconds old.
      startedAt: job?.startedAt ?? live?.startedAt ?? null,
    }
  })

/**
 * Stop the turn, not just the reading of it.
 *
 * `stop()` from the chat hook aborts the browser's fetch, which is all it can do — the turn goes
 * on running on the server, and the coding agent goes on running in its container, for up to its
 * whole budget. So the button said stop and nothing stopped: the tokens were still being spent,
 * the container was still held, and the next turn would have raced whatever was left.
 *
 * Closing the run is what lets a reconnecting page know it is over; killing the agent is what
 * actually gives the time back. Both are best effort — a stop that fails must not itself fail.
 */
export const stopTurn = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId?: string }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    const jobs = await svc(JobRepository)
    const job = await jobs.requestCancel(project.id)
    if (job) await (await svc(JobQueueService)).cancel(job.id)
    else await (await svc(ConversationService)).endRun(project.id).catch(() => { /* legacy run */ })
    return { ok: true }
  })

/** Actual draft changes extend an existing warm lease; they never wake a cold container. */
export const composerActivity = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const { app } = await requireApp(data.projectId, data.appId)
    const activity = await (await svc(SandboxLeaseService)).composerActivity(app.id)
    if (!activity) return { warm: false }
    const versions = await (await svc(AppsService)).versions(app.id)
    await (await svc(JobQueueService)).scheduleRelease({
      appId: app.id, generation: activity.generation, expectedSourceVersion: versions.sourceVersion,
    }, activity.warmUntil)
    if (activity.keepalive) {
      const sandbox = await svc(SandboxService)
      await sandbox.claimLease(app.id, activity.generation).then(() => sandbox.state(app.id)).catch(() => {})
    }
    return { warm: true, warmUntil: activity.warmUntil }
  })

/** Drop everything after (and including) a message, so a user can edit and resend. */
export const truncateChat = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; messageId: string }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    await (await svc(ConversationService)).truncateChat(project.id, data.messageId)
    return { ok: true }
  })

/** Append messages produced outside the chat stream (e.g. a sandbox agent turn) to the transcript. */
export const appendChat = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; messages: unknown[] }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    await (await svc(ConversationService)).appendChat(project.id, data.messages)
    return { ok: true }
  })

/**
 * The transcript of the turn being watched, kept here so the container is only ever asked for the
 * part it has not already given us.
 *
 * The chat polls `buildActivity` for the whole of a build. Reading the agent's event stream meant
 * an `exec` inside the container that is running the agent — half a vCPU, a region away — and the
 * old call pulled the last 200KB every single time, so watching a turn got more expensive the
 * longer the turn went on. Only the new bytes cross that hop now; this is where they are put back
 * together, because `parseActivity` needs the whole stream and belongs on the server.
 *
 * A cache, not state: losing it costs one full re-read. The app runs as a single instance, and a
 * miss is corrected by the sandbox handing back a tail and saying `reset`.
 */
const TRANSCRIPT_CAP = 400_000
const WATCHED_APPS = 50
const transcripts = new Map<string, { text: string; next: number }>()

/** What Boris is doing right now in this app's sandbox. Polled by the chat while a build runs. */
export const buildActivity = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    await requireApp(data.projectId, data.appId)
    try {
      const held = transcripts.get(data.appId)
      const r = await (await svc(SandboxService)).activity(data.appId, held?.next ?? 0)
      // `reset` means the file moved under us — a new turn, or a first read that skipped past a
      // transcript longer than the tail cap. Either way what we held is no longer a prefix of it.
      const text = ((r.reset || !held ? '' : held.text) + r.jsonl).slice(-TRANSCRIPT_CAP)
      transcripts.delete(data.appId)
      if (transcripts.size >= WATCHED_APPS) transcripts.delete(transcripts.keys().next().value!)
      transcripts.set(data.appId, { text, next: r.next })
      return parseActivity(text)
    } catch {
      return { running: false, steps: [], text: '', code: '' }
    }
  })
