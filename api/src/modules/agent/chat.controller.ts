import { Controller, Get, Logger, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { UI_MESSAGE_STREAM_HEADERS, type UIMessage } from 'ai'
import { jsonBody, requestHeaders, sendFetchResponse } from '../../common/http'
import { Public } from '../../common/public.decorator'
import { AccessService } from '../auth/access.service'
import { AppsService } from '../apps/apps.service'
import { ConversationService } from '../projects/conversation.service'
import { RunStreamService } from '../projects/run-stream.service'
import { CreditsService, OutOfCredits } from '../credits/credits.service'
import { LlmService } from '../llm/llm.service'
import { TurnService } from './turn.service'
import { NamingService } from './naming.service'
import { RatesService } from '../billing/rates.service'
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
    private readonly turns: TurnService,
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
    // From this process's memory when it is the one running the turn; from the recording when
    // the turn ran elsewhere, or in a process that is gone.
    const body = this.turns.attach(runId) ?? this.runStream.replay(runId, () => this.conversation.runLive(runId))
    sendFetchResponse(res, withHeartbeat(new globalThis.Response(body, { headers: { 'Content-Type': 'text/event-stream' } })))
  }

  @Post(':projectId')
  async turn(@Req() req: Request, @Res() res: Response) {
    const headers = requestHeaders(req)
    let ctx
    try { ctx = await this.access.requireProject(headers, String(req.params.projectId)) } catch { return void res.status(401).send('unauthorized') }
    const { user, project } = ctx
    // A process on its way out must not start a turn it cannot finish. The client says so and
    // asks again; the replacement process is seconds away.
    if (this.turns.draining) return void res.status(503).json({ error: 'restarting' })

    // Read the body first: the tier the user picked in the composer arrives with it, and it
    // decides which model answers.
    const { messages, appId, tier } = await jsonBody<{
      messages: UIMessage[]; appId?: string; tier?: Tier
    }>(req, 'bad json')

    const cfg = await this.llm.configFor(user.id, tier)
    if (!cfg) return void res.status(409).send('No model configured: add your own API key under Settings')

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

    // Persist the question and mark the run live before the model is called: a refresh mid-turn
    // then shows the question plus "still running" instead of an empty chat.
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

    // The turn is the service's from here; this response is one reader of it. See TurnService
    // for why the two are separate: what happens to this connection no longer happens to the turn.
    const live = await this.turns.start({ runId, project, app, userId: user.id, cfg, stored, forModel, pricer, byok: cfg.source === 'user' })

    // When the reader goes away mid-turn, say so, with the two numbers that tell a proxy timeout
    // apart from a browser that left: how far in, and how long the line had been quiet.
    const startedAt = Date.now()
    const stats = { lastByteAt: Date.now() }
    res.on('close', () => {
      if (live.ended) return
      this.log.warn(`reader left run ${runId} of ${project.id} ${secondsSince(startedAt)}s in, ${secondsSince(stats.lastByteAt)}s after the last byte; the turn carries on`)
    })
    sendFetchResponse(res, withHeartbeat(new globalThis.Response(this.turns.attach(runId), { headers: UI_MESSAGE_STREAM_HEADERS }), stats))
  }
}
