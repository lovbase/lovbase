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

  /**
   * A chat attachment. Both key shapes land here; the project id comes from the key, not the URL.
   *
   * One decorator listing both, because two `@Get`s do not do that: the decorator writes
   * `PATH_METADATA` with `defineMetadata`, so the second overwrites the first and only the topmost
   * path is ever registered. Written as a stack, this route had been answering `private/chat/…`
   * alone, and the `projects/…` shape the comment promised was never mapped at all.
   */
  @Get(['private/chat/:projectId/*name', 'projects/:projectId/*name'])
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
    return this.send(res, key, { shared: true })
  }

  /** A published app's cover. Public for the same reason an avatar is, and replaced on each publish. */
  @Get('public/thumb/:projectId/*name')
  async thumb(@Req() req: Request, @Res() res: Response) {
    const key = keyFor(FILES_PREFIX + req.path.replace(/^\/?api\/files\//, ''))
    const parsed = key ? parseKey(key) : null
    if (!key || parsed?.kind !== 'thumb') return void res.status(400).send('bad key')
    // Versioned by the caller (`?v=<cover_at>`), so the bytes at a given URL never change.
    return this.send(res, key, { shared: true })
  }

  private async send(res: Response, key: string, { shared = false } = {}) {
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
    // Every URL here is immutable: keys are uuids, and a cover's stable key is versioned by the
    // caller. What differs is who may keep a copy. Anything under `public/` is served without an
    // access check, so the CDN can hold it and most requests never reach this process at all —
    // which is the whole difference between a cover appearing at once and appearing after a round
    // trip to object storage. A chat attachment is behind a project check and stays `private`.
    res.setHeader('cache-control', `${shared ? 'public' : 'private'}, max-age=31536000, immutable`)
    // Uploaded content served from our own origin: never let a browser sniff it into HTML.
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-disposition', 'inline')
    res.end(Buffer.from(got.bytes))
  }
}
