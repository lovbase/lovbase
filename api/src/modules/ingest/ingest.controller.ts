import { All, Controller, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { ConfigService } from '../../config/config.service'
import { requestUrl, sendFetchResponse } from '../../common/http'
import { Public } from '../../common/public.decorator'

// Analytics reverse proxy. Requests go to our own origin and are forwarded to PostHog, so the
// calls are first-party and content blockers — which cut a meaningful share of analytics — do not
// drop them. Two upstreams, as PostHog splits them: the ingestion API and the static bundle host.

/** Headers that must never travel to a third party or leak their cookies back onto our domain. */
const STRIP_REQUEST = new Set(['cookie', 'authorization', 'host', 'x-forwarded-host', 'x-forwarded-proto'])
const STRIP_RESPONSE = ['set-cookie', 'strict-transport-security']

@Public()
@Controller('ingest')
export class IngestController {
  constructor(private readonly cfg: ConfigService) {}

  @All('*path')
  async proxy(@Req() req: Request, @Res() res: Response) {
    const url = requestUrl(req)
    const splat = url.pathname.replace(/^\/ingest\/?/, '')
    // `/ingest/static/...` is the library bundle; everything else is ingestion.
    const upstream = splat.startsWith('static/') ? this.cfg.env.POSTHOG_ASSET_HOST : this.cfg.env.POSTHOG_API_HOST
    const target = new URL(`https://${upstream}/${splat}${url.search}`)

    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (STRIP_REQUEST.has(k.toLowerCase())) continue
      if (typeof v === 'string') headers.set(k, v)
    }
    headers.set('host', upstream)

    const upstreamRes = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : (req as any),
      duplex: 'half',
      redirect: 'follow',
    })

    const out = new Headers(upstreamRes.headers)
    for (const h of STRIP_RESPONSE) out.delete(h)
    sendFetchResponse(res, new Response(upstreamRes.body, { status: upstreamRes.status, headers: out }))
  }
}
