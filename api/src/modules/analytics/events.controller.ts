import { Controller, Options, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { EVENT_CORS } from '../../common/cors'
import { rawBody } from '../../common/http'
import { Public } from '../../common/public.decorator'
import { ProjectsService } from '../projects/projects.service'
import { AnalyticsService, type EventIn } from './analytics.service'

/** Public beacon for generated apps. No token: it only ever appends anonymous events for a known app. */
@Public()
@Controller(['api/data/:workspaceId/events', 'w/:workspaceId/events'])
export class EventsController {
  constructor(private readonly projects: ProjectsService, private readonly analytics: AnalyticsService) {}

  @Options()
  preflight(@Res() res: Response) {
    res.status(204).set(EVENT_CORS).end()
  }

  @Post()
  async ingest(@Req() req: Request, @Res() res: Response) {
    const project = await this.projects.find(String(req.params.workspaceId))
    if (!project) return void res.status(404).set(EVENT_CORS).send('unknown app')

    let body: { events?: unknown }
    try { body = JSON.parse((await rawBody(req)).toString('utf8')) } catch { return void res.status(400).set(EVENT_CORS).send('bad json') }

    const raw = Array.isArray(body.events) ? body.events.slice(0, 50) : []
    const events: EventIn[] = raw
      .filter((e: any) => e && (e.type === 'pageview' || e.type === 'leave') && typeof e.path === 'string')
      .map((e: any) => ({
        type: e.type,
        path: e.path,
        referrer: typeof e.referrer === 'string' ? hostOf(e.referrer, req) : null,
        duration_ms: typeof e.duration_ms === 'number' ? Math.min(Math.max(0, Math.round(e.duration_ms)), 6 * 3600_000) : null,
      }))

    const ua = (req.headers['user-agent'] as string) ?? ''
    const country = (req.headers['cf-ipcountry'] as string) ?? null
    await this.analytics.insert(
      project.id,
      await visitorId(req, project.id),
      country === 'XX' ? null : country,
      deviceOf(ua),
      events,
    )
    res.status(204).set(EVENT_CORS).end()
  }
}

/** Daily-rotating hash of ip + ua + app: counts unique people for a day without storing who they are. */
async function visitorId(req: Request, projectId: string) {
  const ip = (req.headers['cf-connecting-ip'] as string) ?? (req.headers['x-forwarded-for'] as string) ?? 'local'
  const ua = (req.headers['user-agent'] as string) ?? ''
  const day = new Date().toISOString().slice(0, 10)
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}|${ua}|${projectId}|${day}`))
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function deviceOf(ua: string) {
  if (/ipad|tablet/i.test(ua)) return '平板'
  if (/mobile|iphone|android/i.test(ua)) return '手机'
  return '桌面'
}

/** Referrer → its host, dropping self-referrals (SPA navigation). */
function hostOf(ref: string, req: Request): string | null {
  try {
    const h = new URL(ref).host
    const origin = req.headers.origin
    if (origin && new URL(origin).host === h) return null
    return h
  } catch { return null }
}
