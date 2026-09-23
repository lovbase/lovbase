import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common'
import { JsonToSseTransformStream, readUIMessageStream, type StreamTextResult, type UIMessage } from 'ai'
import type { Tier } from '@lovbase/core/billing'
import type { LlmConfig } from '../llm/llm.service'
import type { Project } from '../projects/project.types'
import type { App } from '../apps/apps.service'
import { ConversationService } from '../projects/conversation.service'
import { RunStreamService } from '../projects/run-stream.service'
import { CreditsService } from '../credits/credits.service'
import type { Pricer } from '../billing/rates.service'
import { AgentService } from './agent.service'

/**
 * A turn as a job the server runs, rather than as the body of one HTTP response.
 *
 * The turn used to live inside the request handler: the model loop was consumed by the response
 * stream, the assistant message was written to the transcript in the response's finish callback,
 * and the run row was closed there too. So whatever happened to the response happened to the
 * turn — a proxy dropping a quiet connection, a browser reloading, a deploy replacing the process
 * — and the answer to "where did the last ten minutes go" was that nothing had ever written them
 * down. The coding agent, detached in its container, finished the app anyway; the transcript had
 * a question with no answer under it.
 *
 * Here the loop is driven by the service. What it produces goes three ways as it happens: into
 * memory, so any number of readers can attach and read from the beginning; into the transcript,
 * saved every second, so a process that dies mid-turn leaves the steps it took; and into the run
 * recording, for a reader arriving after this process is gone. A response is just a reader.
 */

/** How often the transcript is rewritten while a turn runs. Finer than this is a write per token. */
const SAVE_EVERY_MS = 1000
/** How often a live run says it is alive. `ConversationService` writes off a run quiet for longer. */
const TOUCH_EVERY_MS = 10_000
/** A finished turn stays attachable from memory this long; after that the recording serves it. */
const KEEP_FINISHED_MS = 60_000
/** How long a shutdown waits for turns in flight before letting the process go. */
const DRAIN_MS = 20 * 60_000

export type TurnInput = {
  runId: string
  project: Project
  app: App
  userId: string
  cfg: LlmConfig
  /** The transcript as stored, the new question included. */
  stored: UIMessage[]
  /** The same, with attachment bytes back in place for the model. */
  forModel: UIMessage[]
  pricer: Pricer
  byok: boolean
}

type Live = {
  runId: string
  projectId: string
  chunks: string[]
  listeners: Set<(chunk: string | null) => void>
  ended: boolean
  abort: AbortController
  done: Promise<void>
}

const enc = new TextEncoder()

@Injectable()
export class TurnService implements OnApplicationShutdown {
  private readonly log = new Logger('turn')
  private readonly live = new Map<string, Live>()
  /** Set once the process has been told to stop: no new turns, the ones running are waited for. */
  draining = false

  constructor(
    private readonly agent: AgentService,
    private readonly conversation: ConversationService,
    private readonly runStream: RunStreamService,
    private readonly credits: CreditsService,
  ) {}

  /** Start the turn. Returns as soon as the model has been called; the work goes on without the caller. */
  async start(input: TurnInput): Promise<Live> {
    const { runId, project, app, userId, cfg, stored, forModel, pricer, byok } = input
    const startedAt = Date.now()
    const abort = new AbortController()
    let toolCredits = 0
    let touched = false
    const live: Live = { runId, projectId: project.id, chunks: [], listeners: new Set(), ended: false, abort, done: Promise.resolve() }
    this.live.set(runId, live)

    // The container starts coming up now, under the model's first tokens — see `AgentService.prepare`.
    const ensureSource = this.agent.prepare(project, app.id)
    const stream = await this.agent.stream(project, cfg, forModel, app.id, app.name, userId,
      (p) => { void this.conversation.saveProgress(project.id, p) },
      (credits) => { toolCredits += credits },
      () => { touched = true },
      ensureSource, abort.signal)

    // Every save of the transcript goes through one chain, so a slower partial save can never
    // land on top of the final one.
    let saves = Promise.resolve()
    let finalSaved = false
    const save = (messages: UIMessage[]) => {
      saves = saves.then(() => this.conversation.saveChat(project.id, messages.slice(-200)))
        .catch((err) => this.log.error(`save failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`))
      return saves
    }

    let finished = false
    const finish = async (all?: UIMessage[]) => {
      if (finished) return
      finished = true
      finalSaved = true
      await saves
      if (all) await this.conversation.saveChat(project.id, all.slice(-200))
      else await this.conversation.sealChat(project.id, '这一步没有完成')
      await this.conversation.endRun(project.id).catch(() => { /* nothing to close */ })
    }

    const ui = stream.toUIMessageStream({
      originalMessages: stored,
      generateMessageId: () => crypto.randomUUID(),
      /**
       * What this turn cost, attached to the answer itself.
       *
       * Credits are metered rather than fixed, so "how much did that one cost me" was a question
       * the product could only answer the next day on the account page — and how long it took
       * was a thing only the tool steps reported, never the turn. Both ride along with the
       * message and are saved with it, so they are still there after a reload.
       */
      messageMetadata: ({ part }) => {
        if (part.type !== 'finish') return undefined
        const usage = { inTokens: part.totalUsage?.inputTokens ?? 0, outTokens: part.totalUsage?.outputTokens ?? 0 }
        return {
          credits: pricer.charge(usage, byok).credits + toolCredits,
          ms: Date.now() - startedAt,
          byok, tier: pricer.tier, model: cfg.model,
          inTokens: usage.inTokens, outTokens: usage.outTokens,
          // When, as well as how long: a transcript read back the next morning has no other way
          // to place a turn in the day, and duration alone says nothing about when it happened.
          at: Date.now(),
        }
      },
      onFinish: async ({ messages: all }) => {
        await finish(all)
        await this.meter(userId, project.id, cfg, pricer, stream)
        if (touched) void this.agent.finishBuild(project, app.id)
      },
      onError: (e) => (e instanceof Error ? e.message : String(e)),
    })

    // Three readers of one stream: the transcript, the recording, and whoever is attached now.
    const [forSave, forWire] = ui.tee()
    const [forRecord, forReaders] = forWire.pipeThrough(new JsonToSseTransformStream()).tee()
    void this.persist(forSave, stored, save, () => finalSaved)
    void this.runStream.capture(runId, forRecord)

    const touch = setInterval(() => { void this.conversation.touchRun(runId) }, TOUCH_EVERY_MS)
    live.done = (async () => {
      try {
        const reader = forReaders.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          live.chunks.push(value)
          for (const l of live.listeners) l(value)
        }
      } catch (err) {
        this.log.error(`turn ${runId} broke off: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        clearInterval(touch)
        // The stream ending without `onFinish` — a thrown error, a process on its way down — must
        // still leave a closed run and a transcript that says the last step did not complete.
        await finish().catch(() => { /* logged by the saver */ })
        live.ended = true
        for (const l of live.listeners) l(null)
        live.listeners.clear()
        setTimeout(() => { if (this.live.get(runId) === live) this.live.delete(runId) }, KEEP_FINISHED_MS).unref?.()
      }
    })()
    return live
  }

  /**
   * The transcript, rewritten as the turn goes.
   *
   * `readUIMessageStream` hands back the assistant message as it stands after every chunk; one
   * write a second is plenty for a page that reloads into it, and nothing compared with the tokens
   * arriving. Stops the moment the final save has happened — a partial that arrived late must not
   * be written over the whole.
   */
  private async persist(stream: ReadableStream<any>, stored: UIMessage[], save: (m: UIMessage[]) => Promise<void>, isFinal: () => boolean) {
    let last = 0
    try {
      for await (const message of readUIMessageStream({ stream })) {
        if (isFinal()) break
        const now = Date.now()
        if (now - last < SAVE_EVERY_MS) continue
        last = now
        void save([...stored, message as UIMessage])
      }
    } catch (err) {
      this.log.error(`persist failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * The turn from its beginning, then the rest as it arrives. Null when this process is not
   * running it — the recording in Postgres is the fallback for that.
   */
  attach(runId: string): ReadableStream<Uint8Array> | null {
    const live = this.live.get(runId)
    if (!live) return null
    let listener: ((chunk: string | null) => void) | null = null
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of live.chunks) controller.enqueue(enc.encode(c))
        if (live.ended) return controller.close()
        listener = (c) => {
          try { if (c === null) controller.close(); else controller.enqueue(enc.encode(c)) } catch { /* reader gone */ }
        }
        live.listeners.add(listener)
      },
      cancel() {
        if (listener) live.listeners.delete(listener)
      },
    })
  }

  /** Stop the model loop of the project's running turn, if this process holds it. */
  abort(projectId: string): boolean {
    for (const live of this.live.values()) {
      if (live.projectId !== projectId || live.ended) continue
      live.abort.abort()
      return true
    }
    return false
  }

  /**
   * Charge for what the turn consumed. `totalUsage` sums every step of the tool loop — `usage`
   * alone is the last step only, which for a ten-step run is a rounding error on the real bill.
   *
   * A BYOK turn records its tokens and costs nothing: the user paid the provider directly, and
   * charging them again would penalise the one behaviour that lowers our bill.
   */
  private async meter(
    userId: string,
    projectId: string,
    cfg: { model: string; source: 'user' | 'platform'; tier?: Tier },
    pricer: Pricer,
    stream: StreamTextResult<any, any, any>,
  ) {
    try {
      const total = await stream.totalUsage
      if (!total) return
      const byok = cfg.source === 'user'
      const usage = { inTokens: total.inputTokens ?? 0, outTokens: total.outputTokens ?? 0 }
      const charge = pricer.charge(usage, byok)
      await this.credits.charge(userId, {
        kind: 'message', credits: charge.credits, costUsd: charge.costUsd,
        usage, byok, projectId, model: cfg.model,
      })
    } catch { /* a missed ledger row must not fail a turn the user already received */ }
  }

  /**
   * A deploy replaces the process; the turns it is running are not the deploy's to throw away.
   * New turns are refused from here on, and the ones in flight are waited for — for as long as a
   * build is allowed to take. The platform's draining window has to be at least this long for
   * the wait to mean anything.
   */
  async onApplicationShutdown() {
    this.draining = true
    const running = [...this.live.values()].filter((l) => !l.ended)
    if (running.length === 0) return
    this.log.warn(`shutting down with ${running.length} turn(s) running; waiting for them`)
    await Promise.race([
      Promise.allSettled(running.map((l) => l.done)),
      new Promise((r) => setTimeout(r, DRAIN_MS)),
    ])
  }
}
