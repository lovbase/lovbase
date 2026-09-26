import { Controller, Get, Logger, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { UI_MESSAGE_STREAM_HEADERS, type UIMessage } from 'ai'
import { jsonBody, requestHeaders, sendFetchResponse } from '../../common/http'
import { withHeartbeat } from '../../common/sse'
import { Public } from '../../common/public.decorator'
import { AccessService } from '../auth/access.service'
import { AppsService } from '../apps/apps.service'
import { ConversationService } from '../projects/conversation.service'
import { RunStreamService } from '../projects/run-stream.service'
import { CreditsService, OutOfCredits } from '../credits/credits.service'
import { LlmService } from '../llm/llm.service'
import { TurnService } from './turn.service'
import { NamingService } from './naming.service'
import { AttachmentsService } from '../storage/attachments.service'
import type { Tier } from '@lovbase/core/billing'
import { JobQueueService } from '../jobs/job-queue.service'
import { JobRepository } from '../jobs/job.repository'

const secondsSince = (t: number) => Math.round((Date.now() - t) / 1000)

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
    private readonly attachments: AttachmentsService,
    private readonly jobs: JobRepository,
    private readonly queue: JobQueueService,
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

    const job = await this.jobs.activeForProject(ctx.project.id)
    const live = job ? { id: job.run_id } : await this.conversation.liveRun(ctx.project.id)
    // A run from before runs were named cannot be replayed; there is nothing filed under it.
    if (!live?.id) return void res.status(204).end()
    const runId = live.id
    const body = this.turns.attach(runId) ?? await this.runStream.replay(
      runId,
      async () => await this.jobs.runActive(runId) || await this.conversation.runLive(runId),
      !!job,
      job ? () => this.jobs.terminalErrorForRun(runId) : undefined,
    )
    // Expired, unavailable, or pre-migration recordings use the client's transcript polling.
    if (!body) return void res.status(204).end()

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // The protocol header also applies to resumed UI message streams.
    res.set(UI_MESSAGE_STREAM_HEADERS)
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
    const { messages, appId, tier, requestId: explicitRequestId, trigger, messageId } = await jsonBody<{
      messages: UIMessage[]; appId?: string; tier?: Tier; requestId?: string
      trigger?: string; messageId?: string
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
    const app = (appId && (await this.apps.find(project.id, appId))) || (await this.apps.list(project.id))[0]
    if (!app) return void res.status(400).send('no app')

    // Bytes go to object storage, so every downstream step — persistence, the model call, the
    // resumed transcript — sees the same URL-shaped message. Without this a screenshot is base64
    // in `lb_chat`, re-read on every page load and re-sent on every later turn.
    //
    // After the gates above, not before: a turn rejected for no model or no credits would
    // otherwise have paid for an upload nothing ever references, once per attempt.
    const stored = await this.attachments.offload(project.id, messages)

    const lastMessage = stored[stored.length - 1]
    const requestId = req.get('idempotency-key') || explicitRequestId ||
      `${project.id}:${trigger ?? 'submit-message'}:${messageId ?? lastMessage?.id ?? crypto.randomUUID()}`
    // Chat, run marker and immutable execution input commit together. Redis delivery happens only
    // after commit and is repaired by the worker reconciler when Redis is temporarily unavailable.
    const { job, created } = await this.jobs.createTurn({
      requestId, projectId: project.id, appId: app.id, userId: user.id,
      turn: { appId: app.id, messages: stored, tier },
    })
    const runId = job.run_id

    // A project is named from the message that started it, alongside the turn rather than in
    // front of it: the answer is what the user is waiting for, and a title is worth none of it.
    if (created) {
      void this.naming.nameFromFirstMessage(project, app.id, user.id, stored)
      await this.queue.enqueue(job.id)
    }

    const body = await this.runStream.replay(
      runId,
      () => this.jobs.runActive(runId),
      true,
      () => this.jobs.terminalErrorForRun(runId),
    )
    if (!body) return void res.status(204).end()

    // When the reader goes away mid-turn, say so, with the two numbers that tell a proxy timeout
    // apart from a browser that left: how far in, and how long the line had been quiet.
    const startedAt = Date.now()
    const stats = { lastByteAt: Date.now() }
    res.on('close', async () => {
      if (!await this.jobs.runActive(runId).catch(() => false)) return
      this.log.warn(`reader left run ${runId} of ${project.id} ${secondsSince(startedAt)}s in, ${secondsSince(stats.lastByteAt)}s after the last byte; the turn carries on`)
    })
    res.set('X-Lovbase-Job-Id', job.id)
    res.set('X-Lovbase-Run-Id', runId)
    sendFetchResponse(res, withHeartbeat(new globalThis.Response(body, { headers: UI_MESSAGE_STREAM_HEADERS }), stats))
  }
}
