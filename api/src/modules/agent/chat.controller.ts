import { Controller, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { UIMessage } from 'ai'
import { jsonBody, requestHeaders, sendFetchResponse } from '../../common/http'
import { Public } from '../../common/public.decorator'
import { AccessService } from '../auth/access.service'
import { AppsService } from '../apps/apps.service'
import { ConversationService } from '../projects/conversation.service'
import { CreditsService, OutOfCredits } from '../credits/credits.service'
import { LlmService } from '../llm/llm.service'
import { AgentService } from './agent.service'
import { RatesService } from '../billing/rates.service'
import { AttachmentsService } from '../storage/attachments.service'
import type { Tier } from '@lovbase/core/billing'

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
  constructor(
    private readonly access: AccessService,
    private readonly apps: AppsService,
    private readonly conversation: ConversationService,
    private readonly credits: CreditsService,
    private readonly llm: LlmService,
    private readonly agent: AgentService,
    private readonly rates: RatesService,
    private readonly attachments: AttachmentsService,
  ) {}

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
    await this.conversation.startRun(project.id)

    // The model needs the actual bytes; storage is where they are now.
    const forModel = await this.attachments.rehydrate(stored)
    const stream = await this.agent.stream(project, cfg, forModel, app.id, app.name, user.id,
      (p) => { void this.conversation.saveProgress(project.id, p) })

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

    sendFetchResponse(res, stream.toUIMessageStreamResponse({
      originalMessages: stored,
      generateMessageId: () => crypto.randomUUID(),
      onFinish: async ({ messages: all }) => {
        await this.conversation.saveChat(project.id, all.slice(-200))
        await endRun()
        await this.meter(user.id, project.id, cfg, stream)
      },
      onError: (e) => {
        // Not `void`: the page polling for this run needs the row closed before it will stop.
        void endRun()
        return e instanceof Error ? e.message : String(e)
      },
    }))
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
    stream: { totalUsage: PromiseLike<{ inputTokens?: number; outputTokens?: number }> },
  ) {
    try {
      const total = await stream.totalUsage
      if (!total) return
      const byok = cfg.source === 'user'
      const usage = { inTokens: total.inputTokens ?? 0, outTokens: total.outputTokens ?? 0 }
      const charge = await this.rates.forTokens(cfg.model, usage, byok, cfg.tier)
      await this.credits.charge(userId, {
        kind: 'message', credits: charge.credits, costUsd: charge.costUsd,
        usage, byok, projectId, model: cfg.model,
      })
    } catch { /* a missed ledger row must not fail a turn the user already received */ }
  }
}
