import { Controller, Get, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { ConfigService } from '../../config/config.service'
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
 * It is not a published app and must never become one. A published app is a decision its author
 * made, at a subdomain, served by the Worker. This is private: the bytes come through here, behind
 * the same project check that guards everything else, and the sandbox refuses to serve the prefix
 * they live under. `@Public()` is in the Nest sense only — the check below is the real one, and it
 * needs the app id from the path before it knows which project to ask about.
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

  @Get(':appId/*name')
  @Get(':appId')
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

    const at = { bucket: this.cfg.env.SANDBOX_BUCKET, endpoint: this.cfg.sandboxEndpoint }
    const prefix = `snap/${appId}/`
    // Fall back to the document, the way the Worker does for published apps: these are SPAs, and
    // a client-side route is not a file.
    const hit = (await this.storage.get(prefix + rel, at))
      ?? (await this.storage.get(`${prefix}index.html`, at))
    if (!hit) return void res.status(404).send('not found')

    const isDoc = !rel || rel.endsWith('.html')
    res.setHeader('Content-Type', hit.contentType)
    // Asset names are content-hashed, so they may be held for good; the document never can be, or
    // a rebuilt snapshot would keep serving the previous one. `private` either way — this response
    // passed an access check and must not be held by anything shared.
    res.setHeader('Cache-Control', isDoc ? 'no-store' : 'private, max-age=31536000, immutable')
    // The snapshot is somebody's generated app, not ours: keep it from reaching back into the
    // session that is serving it.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'")
    res.setHeader('X-Content-Type-Options', 'nosniff')
    return void res.send(Buffer.from(hit.bytes))
  }
}

/** Relative paths only, no traversal; an empty tail is the document. */
function safeRel(tail: string): string | null {
  const rel = tail.replace(/^\/+/, '')
  if (rel.includes('..') || rel.includes('\0')) return null
  return rel || 'index.html'
}
