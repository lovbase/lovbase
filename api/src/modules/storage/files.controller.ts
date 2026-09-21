import { Controller, Get, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { requestHeaders } from '../../common/http'
import { Public } from '../../common/public.decorator'
import { AccessService } from '../auth/access.service'
import { StorageService } from './storage.service'
import { keyFor, FILES_PREFIX } from './attachments.service'
import { parseKey } from './keys'

/**
 * Serving an attachment back to the browser.
 *
 * The bucket is private and stays private: a presigned URL would leak past the moment the viewer
 * loses access, and a public bucket would mean anyone holding a key could read anyone's uploads.
 * So reads come through here, where the same project check that guards the rest of the project
 * applies. The key carries the project id, which is what makes that check possible.
 *
 * `@Public()` in the Nest sense only — the check below is the real one, and it needs the project
 * id from the path rather than just a valid session.
 */
@Public()
@Controller('api/files')
export class FilesController {
  constructor(
    private readonly access: AccessService,
    private readonly storage: StorageService,
  ) {}

  /** A chat attachment. Both key shapes land here; the project id comes from the key, not the URL. */
  @Get('private/chat/:projectId/*name')
  @Get('projects/:projectId/*name')
  async attachment(@Req() req: Request, @Res() res: Response) {
    const key = keyFor(FILES_PREFIX + req.path.replace(/^\/?api\/files\//, ''))
    const parsed = key ? parseKey(key) : null
    if (!key || parsed?.kind !== 'chat') return void res.status(400).send('bad key')

    // Re-derive the project from the key rather than trusting the route parameter: otherwise a
    // project id the caller may read could be paired with a crafted tail to fetch another one's
    // object.
    if (parsed.owner !== String(req.params.projectId)) return void res.status(400).send('bad key')

    try { await this.access.requireProject(requestHeaders(req), parsed.owner) }
    catch { return void res.status(404).send('not found') } // not 403: do not confirm it exists

    return this.send(res, key)
  }

  /**
   * An avatar. No access check, which is the whole reason the key says `public`: an avatar appears
   * next to a shared project and on pages its owner is not signed in to. The key is a uuid, so it
   * is not guessable, and nothing but an image is ever written under this prefix.
   */
  @Get('public/avatar/:userId/*name')
  async avatar(@Req() req: Request, @Res() res: Response) {
    const key = keyFor(FILES_PREFIX + req.path.replace(/^\/?api\/files\//, ''))
    const parsed = key ? parseKey(key) : null
    if (!key || parsed?.kind !== 'avatar') return void res.status(400).send('bad key')
    return this.send(res, key)
  }

  /** A published app's cover. Public for the same reason an avatar is, and replaced on each publish. */
  @Get('public/thumb/:projectId/*name')
  async thumb(@Req() req: Request, @Res() res: Response) {
    const key = keyFor(FILES_PREFIX + req.path.replace(/^\/?api\/files\//, ''))
    const parsed = key ? parseKey(key) : null
    if (!key || parsed?.kind !== 'thumb') return void res.status(400).send('bad key')
    return this.send(res, key, { immutable: false })
  }

  private async send(res: Response, key: string, { immutable = true } = {}) {
    const got = await this.storage.get(key)
    if (!got) {
      // Never let a miss be cached. A cover is written after its app is published, so the first
      // request for one can legitimately arrive before it exists — and a CDN that remembers that
      // 404 for its default four hours hides the picture long after it is there.
      res.setHeader('cache-control', 'no-store')
      return void res.status(404).send('not found')
    }

    res.setHeader('content-type', got.contentType)
    res.setHeader('content-length', String(got.bytes.byteLength))
    // Most keys are uuids, so an object never changes under its URL. A cover is the exception: its
    // key is stable and its bytes are replaced, so it gets a short life and a revalidation instead.
    res.setHeader('cache-control', immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=60, must-revalidate')
    // Uploaded content served from our own origin: never let a browser sniff it into HTML.
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-disposition', 'inline')
    res.end(Buffer.from(got.bytes))
  }
}
