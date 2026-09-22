import { All, Controller, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { rawBody, sendFetchResponse } from '../../common/http'
import { Public } from '../../common/public.decorator'
import { LlmService } from '../llm/llm.service'
import { ProjectsService } from '../projects/projects.service'
import type { Tier } from '@lovbase/core/billing'

/**
 * The model, as reached from inside a sandbox.
 *
 * The coding agent runs in a container on Cloudflare's network, and the gateway it was handed
 * does not resolve from there — every build died on "Connection error" while the same gateway
 * answered the chat from the app server without complaint. Same host, two different exits. So
 * the container no longer talks to the gateway at all: it talks to this, over the one host it is
 * guaranteed to reach, and this talks to the gateway from where that is known to work.
 *
 * It also takes the key out of the container. The agent used to be handed the platform's API key
 * in a file, inside a box that runs code a model wrote; now it holds only its own workspace token,
 * which is what it would be authenticated by anyway, and the key never leaves this process. That
 * is the shape claude-managed-agents calls credential injection at the egress, arrived at from
 * the other direction.
 *
 * `@Public()` in the Nest sense only: the bearer is a workspace token, checked below, and the
 * owner's own model configuration — theirs if they brought one, the platform's otherwise — is what
 * the request is forwarded with.
 */
@Public()
@Controller('api/llm')
export class LlmRelayController {
  constructor(private readonly projects: ProjectsService, private readonly llm: LlmService) {}

  @All('v1/*tail')
  @All('v1')
  async relay(@Req() req: Request, @Res() res: Response) {
    const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
    const project = bearer ? await this.projects.findByApiToken(bearer) : null
    if (!project) return void res.status(401).json({ error: { message: 'unauthorized' } })

    const body = await rawBody(req)
    // The tier is not in the request, but the model is, and a tier is a model by another name.
    let tier: Tier | undefined
    try {
      const wanted = JSON.parse(body.toString('utf8'))?.model
      tier = (await this.llm.tierOptions()).find((t) => t.model === wanted)?.tier
    } catch { /* not JSON, or no model named: the default tier answers */ }
    const cfg = await this.llm.configFor(project.owner_id, tier)
    if (!cfg) return void res.status(503).json({ error: { message: 'no model configured' } })

    // Everything after `/api/llm/v1` is the gateway's own path: the agent speaks OpenAI's
    // protocol, and so does whatever `baseURL` points at.
    const tail = req.path.replace(/^\/api\/llm\/v1\/?/, '')
    const url = `${cfg.baseURL.replace(/\/+$/, '')}/${tail}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': req.headers['content-type'] ?? 'application/json',
        accept: req.headers.accept ?? '*/*',
      },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      duplex: 'half',
    })
    // Streamed straight through, headers included: a completion is delivered a token at a time
    // and the agent reads it as it arrives.
    sendFetchResponse(res, upstream)
  }
}
