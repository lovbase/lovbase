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
  ) {}

  @Post(':projectId')
  async turn(@Req() req: Request, @Res() res: Response) {
    const headers = requestHeaders(req)
    let ctx
    try { ctx = await this.access.requireProject(headers, String(req.params.projectId)) } catch { return void res.status(401).send('unauthorized') }
    const { user, project } = ctx

    const cfg = await this.llm.configFor(user.id)
    if (!cfg) return void res.status(409).send('未配置模型:到「设置」里填你自己的 API key')

    // Meter the turn before any work starts; 402 is the paywall signal the chat UI renders.
    try {
      await this.credits.assert(user.id, 'message')
    } catch (err) {
      if (err instanceof OutOfCredits)
        return void res.status(402).json({ error: 'out_of_credits', balance: err.balance })
      throw err
    }

    const { messages, appId } = await jsonBody<{ messages: UIMessage[]; appId?: string }>(req, 'bad json')
    const app = (appId && (await this.apps.find(project.id, appId))) || (await this.apps.list(project.id))[0]
    if (!app) return void res.status(400).send('no app')

    // Persist the question and mark the run live before streaming: a refresh mid-turn then
    // shows the question plus "still running" instead of an empty chat.
    await this.conversation.saveChat(project.id, messages.slice(-200))
    await this.conversation.startRun(project.id)

    const stream = await this.agent.stream(project, cfg, messages, app.id, app.name, user.id,
      (p) => { void this.conversation.saveProgress(project.id, p) })
    await this.credits.spend(user.id, 'message', { projectId: project.id, model: cfg.model })

    sendFetchResponse(res, stream.toUIMessageStreamResponse({
      originalMessages: messages,
      generateMessageId: () => crypto.randomUUID(),
      // Persist after every step, not just at the end: a refresh mid-run then shows
      // everything completed so far instead of an empty turn.
      onFinish: async ({ messages: all }) => {
        await this.conversation.saveChat(project.id, all.slice(-200))
        await this.conversation.endRun(project.id)
      },
      onError: (e) => (e instanceof Error ? e.message : String(e)),
    }))
  }
}
