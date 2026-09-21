import { createServerFn } from '@tanstack/react-start'
import { ApplyService, ConversationService, SandboxService, parseActivity, svc } from '@lovbase/api'
import { requireApp, requireProject } from './_ctx'

/** The saved transcript, for resuming a run after a refresh. */
export const chatState = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    const conversation = await svc(ConversationService)
    const live = await conversation.liveRun(project.id)
    return {
      chat: (await conversation.getChat(project.id)) as any,
      pendingIds: await (await svc(ApplyService)).listPendingIds(project.id),
      running: !!live,
      progress: live?.progress ?? null,
      // When the turn began, so a reconnecting page can go on counting from there rather than
      // starting a fresh clock at zero and calling a four-minute build five seconds old.
      startedAt: live?.startedAt ?? null,
    }
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
