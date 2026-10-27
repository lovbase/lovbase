import { Controller, Get, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { ConfigService } from '../../config/config.service'
import { snapshotHost } from '@lovbase/sandbox/snapshot-auth'
import { requestHeaders } from '../../common/http'
import { Public } from '../../common/public.decorator'
import { AccessService } from '../auth/access.service'
import { AppsService } from '../apps/apps.service'
import { StorageService } from './storage.service'

/**
 * The last built copy of an app, served so that opening an old project needs no container.
 *
 * Reopening used to mean waking a container, restoring its source a file at a time and booting a
 * dev server — minutes before the first pixel, for someone who only wanted to look. The sandbox
 * keeps a built copy in object storage after every build; this hands it back, and a container is
 * woken only when something has to be live.
 *
 * This endpoint checks project access and issues a short-lived, per-app preview URL on a
 * separate origin. Application bytes never pass through the authenticated platform origin.
 * `@Public()` is in the Nest sense only — the project check below is the real authorization.
 */
@Public()
@Controller('api/snap')
export class SnapshotController {
  constructor(
    private readonly access: AccessService,
    private readonly apps: AppsService,
    private readonly storage: StorageService,
    private readonly cfg: ConfigService,
  ) {}

  // One decorator with both shapes, not two decorators: `@Get` writes `PATH_METADATA` with
  // `defineMetadata`, so stacking them registers only the topmost and silently drops the rest.
  // Both are needed — the document is asked for as `/api/snap/<id>/`, with nothing after the
  // slash for the wildcard to match, and its assets as `/api/snap/<id>/assets/…`.
  @Get([':appId', ':appId/*name'])
  async file(@Req() req: Request, @Res() res: Response) {
    if (!this.cfg.snapshotsConfigured) return void res.status(404).send('not found')
    const appId = String(req.params.appId ?? '')
    if (!/^[a-z0-9]{1,40}$/.test(appId)) return void res.status(400).send('bad app')

    const app = await this.apps.findById(appId)
    if (!app) return void res.status(404).send('not found')
    // 404 rather than 403 throughout: whether an app exists is itself not public.
    try { await this.access.requireProject(requestHeaders(req), app.project_id) }
    catch { return void res.status(404).send('not found') }

    const rel = safeRel(req.path.slice(`/api/snap/${appId}`.length))
    if (rel === null) return void res.status(400).send('bad path')

    // Never execute application/imported HTML on the platform's authenticated origin.
    // Keep the build's existing /api/snap/<id>/ base on the isolated host too.
    if (!this.cfg.env.SANDBOX_INTERNAL_TOKEN) return void res.status(503).send('Snapshot signing is not configured')
    const label = await snapshotHost(appId, this.cfg.env.SANDBOX_INTERNAL_TOKEN)
    const target = new URL(`/api/snap/${appId}/${rel}`, this.cfg.appUrl(label))
    target.search = new URL(req.originalUrl, 'https://snapshot.invalid').search
    if (target.origin === new URL(this.cfg.env.BETTER_AUTH_URL).origin) return void res.status(503).send('Separate preview origin required')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    return void res.redirect(302, target.href)
  }
}

/** Relative paths only, no traversal; an empty tail is the document. */
function safeRel(tail: string): string | null {
  let rel: string
  try { rel = decodeURIComponent(tail).replace(/^\/+/, '') } catch { return null }
  if (rel.includes('..') || rel.includes('\0')) return null
  return rel || 'index.html'
}
