import { Controller, Get, Logger, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { UIMessage } from 'ai'
import { jsonBody, requestHeaders, sendFetchResponse } from '../../common/http'
import { Public } from '../../common/public.decorator'
import { AccessService } from '../auth/access.service'
import { AppsService } from '../apps/apps.service'
import { ConversationService } from '../projects/conversation.service'
import { RunStreamService } from '../projects/run-stream.service'
import { CreditsService, OutOfCredits } from '../credits/credits.service'
import { LlmService } from '../llm/llm.service'
import { AgentService } from './agent.service'
import { NamingService } from './naming.service'
import { RatesService, type Pricer } from '../billing/rates.service'
import { ConfigService } from '../../config/config.service'
import { AttachmentsService } from '../storage/attachments.service'
import type { Tier } from '@lovbase/core/billing'

/**
 * How often to say something on an otherwise silent turn. Well inside the 100 seconds a proxy in
 * front of this typically allows an idle response, and cheap enough to be unnoticeable.
 */
const HEARTBEAT_MS = 15_000

const secondsSince = (t: number) => Math.round((Date.now() - t) / 1000)

/**
 * Keep a long turn's connection open while it has nothing to say.
 *
 * `edit_app` runs for minutes, and for all of them the stream is silent — the model is blocked on
 * the tool, so not one byte reaches the browser. Every proxy between here and the reader treats a
 * response that quiet as dead and closes it, which the chat surfaces as `network error`: a build
 * that was going perfectly well, abandoned by the page watching it, while the server carried on
 * paying for it.
 *
 * A comment line is the SSE protocol's own answer to this. It carries no event, every conformant
 * parser drops it on the floor, and it is enough to prove the connection is alive.
 */
function withHeartbeat(out: globalThis.Response, stats?: { lastByteAt: number }): globalThis.Response {
  const body = out.body
  if (!body) return out
  const beat = new TextEncoder().encode(': keep-alive\n\n')
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader()
      let open = true
      const timer = setInterval(() => { if (open) try { controller.enqueue(beat) } catch { open = false } }, HEARTBEAT_MS)
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (stats) stats.lastByteAt = Date.now()
          controller.enqueue(value)
        }
        open = false
        controller.close()
      } catch (err) {
        open = false
        controller.error(err)
      } finally {
        clearInterval(timer)
      }
    },
  })
  return new globalThis.Response(stream, { status: out.status, statusText: out.statusText, headers: out.headers })
}

/**
 * The chat turn. Kept as a streaming fetch-style response rather than a JSON controller: the UI
 * consumes the AI SDK's UI message stream, and a turn runs for minutes.
 *
 * `@Public()` because the ownership check is `requireProject` below, which needs the project id
 * from the path — a plain session check would not be enough.
 */
@Public()
@Controller('api/chat')
export class ChatController {
  private readonly log = new Logger('chat')

  constructor(
    private readonly access: AccessService,
    private readonly apps: AppsService,
    private readonly conversation: ConversationService,
    private readonly runStream: RunStreamService,
    private readonly credits: CreditsService,
    private readonly llm: LlmService,
    private readonly agent: AgentService,
    private readonly naming: NamingService,
    private readonly rates: RatesService,
    private readonly attachments: AttachmentsService,
    private readonly cfg: ConfigService,
  ) {}

  /**
   * The turn already in flight, from its beginning.
   *
   * What the SDK's `resume` asks for on every mount: 204 when nothing is running, and otherwise
   * the whole turn — the part already sent, then the rest as it arrives, indistinguishable to the
   * reader. A reload during a build now rejoins the same response instead of being shown a
   * summary of it, which is why everything that used to describe a running turn separately can go.
   */
  @Get(':projectId/stream')
  async resume(@Req() req: Request, @Res() res: Response) {
    const headers = requestHeaders(req)
    let ctx
    try { ctx = await this.access.requireProject(headers, String(req.params.projectId)) } catch { return void res.status(401).send('unauthorized') }

    const live = await this.conversation.liveRun(ctx.project.id)
    // A run from before runs were named cannot be replayed; there is nothing filed under it.
    if (!live?.id) return void res.status(204).end()
    const runId = live.id

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    sendFetchResponse(res, withHeartbeat(new globalThis.Response(
      this.runStream.replay(runId, () => this.conversation.runLive(runId)),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )))
  }

  @Post(':projectId')
  async turn(@Req() req: Request, @Res() res: Response) {
    const headers = requestHeaders(req)
    let ctx
    try { ctx = await this.access.requireProject(headers, String(req.params.projectId)) } catch { return void res.status(401).send('unauthorized') }
    const { user, project } = ctx

    // Read the body first: the tier the user picked in the composer arrives with it, and it
    // decides which model answers.
    const { messages, appId, tier } = await jsonBody<{
      messages: UIMessage[]; appId?: string; tier?: Tier
    }>(req, 'bad json')

    const cfg = await this.llm.configFor(user.id, tier)
    if (!cfg) return void res.status(409).send('未配置模型:到「设置」里填你自己的 API key')

    // The gate is "has any budget left", not "can afford this turn": what a turn costs is only
    // knowable once it has run. 402 is the paywall signal the chat UI renders.
    try {
      await this.credits.assert(user.id, 'message')
    } catch (err) {
      if (err instanceof OutOfCredits)
        return void res.status(402).json({ error: 'out_of_credits', balance: err.balance })
      throw err
    }
    // A build takes a container, and containers are the one cost that is capped rather than
    // metered. Refused here, with a sentence, rather than left to queue inside Cloudflare where it
    // looks to the user like the product has simply stopped. MAX_ACTIVE_BUILDS is the knob.
    //
    // Builds only: a turn that answers a question about the data never asks for a container, and
    // counting it against this allowance refused people a resource nothing was using.
    const busy = await this.conversation.activeBuilds(project.id)
    if (busy >= this.cfg.maxActiveBuilds)
      return void res.status(503).json({ error: 'busy', active: busy, limit: this.cfg.maxActiveBuilds })

    const app = (appId && (await this.apps.find(project.id, appId))) || (await this.apps.list(project.id))[0]
    if (!app) return void res.status(400).send('no app')

    // Bytes go to object storage, so every downstream step — persistence, the model call, the
    // resumed transcript — sees the same URL-shaped message. Without this a screenshot is base64
    // in `lb_chat`, re-read on every page load and re-sent on every later turn.
    //
    // After the gates above, not before: a turn rejected for no model or no credits would
    // otherwise have paid for an upload nothing ever references, once per attempt.
    const stored = await this.attachments.offload(project.id, messages)

    // Persist the question and mark the run live before streaming: a refresh mid-turn then
    // shows the question plus "still running" instead of an empty chat.
    await this.conversation.saveChat(project.id, stored.slice(-200))
    const runId = await this.conversation.startRun(project.id)

    // A project is named from the message that started it, alongside the turn rather than in
    // front of it: the answer is what the user is waiting for, and a title is worth none of it.
    void this.naming.nameFromFirstMessage(project, app.id, user.id, stored)

    // The model needs the actual bytes; storage is where they are now.
    const forModel = await this.attachments.rehydrate(stored)
    // Priced once, up front: the turn quotes its cost to the user on the way out and is charged
    // for it a moment later, and those two have to be the same number.
    const pricer = await this.rates.pricerFor(cfg.model, cfg.tier)
    const byok = cfg.source === 'user'
    // What tools spent inside this turn — a Boris build is charged as it happens, and the user
    // sees one turn, not two line items.
    let toolCredits = 0
    // Whether a file tool changed the app this turn. One build snapshot and one cover at the end,
    // not one per edit: a page is a dozen edits.
    let touched = false
    // Wall clock from here, which is what the person waiting actually experienced. Measuring only
    // the model call would leave out the sandbox, and the sandbox is most of a long turn.
    const startedAt = Date.now()
    // The container starts coming up now, under the model's first tokens, not under its first
    // tool call — see `AgentService.prepare`.
    const ensureSource = this.agent.prepare(project, app.id)
    const stream = await this.agent.stream(project, cfg, forModel, app.id, app.name, user.id,
      (p) => { void this.conversation.saveProgress(project.id, p) },
      (credits) => { toolCredits += credits },
      () => { touched = true },
      ensureSource)

    // The run row is what tells a reloaded page whether this turn is still going. It has to be
    // closed on every exit, not just the happy one: a turn that failed used to leave it open, so
    // `runActive` kept saying yes for its full fifteen minutes and the reconnecting UI span until
    // its own five-minute deadline gave up. The only way out of "正在接回…" was to wait it out.
    let ended = false
    const endRun = async () => {
      if (ended) return
      ended = true
      await this.conversation.endRun(project.id).catch(() => { /* the poll's own window bounds this */ })
    }

    // When the reader goes away mid-turn, say so, with the two numbers that tell a proxy timeout
    // apart from a browser that left: how far in, and how long the line had been quiet. The turn
    // itself is not stopped — the heartbeat loop drains the model whether anyone is reading or not.
    const stats = { lastByteAt: Date.now() }
    res.on('close', () => {
      if (ended) return
      this.log.warn(`reader left run ${runId} of ${project.id} ${secondsSince(startedAt)}s in, ${secondsSince(stats.lastByteAt)}s after the last byte; the turn carries on`)
    })
    sendFetchResponse(res, withHeartbeat(stream.toUIMessageStreamResponse({
      originalMessages: stored,
      generateMessageId: () => crypto.randomUUID(),
      /**
       * What this turn cost, attached to the answer itself.
       *
       * Credits are metered rather than fixed, so "how much did that one cost me" was a question
       * the product could only answer the next day on the account page — and how long it took was
       * a thing only the tool steps reported, never the turn. Both ride along with the message and
       * are saved with it, so they are still there after a reload.
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
        await this.conversation.saveChat(project.id, all.slice(-200))
        await endRun()
        await this.meter(user.id, project.id, cfg, pricer, stream)
        if (touched) void this.agent.finishBuild(project, app.id)
      },
      onError: (e) => {
        // Not `void`: a page waiting on this run needs the row closed before it will stop.
        void endRun()
        return e instanceof Error ? e.message : String(e)
      },
      /**
       * The same bytes, written down as they go out.
       *
       * A tee, so the reader is never waiting on a database — and the only reason a reload can be
       * handed this turn rather than a description of it. Not awaited: it outlives the request.
       */
      consumeSseStream: ({ stream: copy }) => { void this.runStream.capture(runId, copy) },
    }), stats))
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
    stream: { totalUsage: PromiseLike<{ inputTokens?: number; outputTokens?: number }> },
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
}
