import { Controller, Get, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { requestHeaders } from '../../common/http'
import { Public } from '../../common/public.decorator'
import { AccessService } from '../auth/access.service'
import { StorageService } from './storage.service'
import { keyFor, FILES_PREFIX } from './attachments.service'

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

  @Get('projects/:projectId/*name')
  async get(@Req() req: Request, @Res() res: Response) {
    const key = keyFor(FILES_PREFIX + req.path.replace(/^\/?api\/files\//, ''))
    if (!key) return void res.status(400).send('bad key')

    const projectId = String(req.params.projectId)
    try { await this.access.requireProject(requestHeaders(req), projectId) }
    catch { return void res.status(404).send('not found') } // not 403: do not confirm it exists

    // The key is built from the path, so re-derive the project from the key itself and refuse a
    // mismatch. Otherwise a readable project id in the route could be used to fetch another one's
    // object through a crafted tail.
    if (!key.startsWith(`projects/${projectId}/`)) return void res.status(400).send('bad key')

    const got = await this.storage.get(key)
    if (!got) return void res.status(404).send('not found')

    res.setHeader('content-type', got.contentType)
    res.setHeader('content-length', String(got.bytes.byteLength))
    // Keys are uuids, so an object never changes under its URL.
    res.setHeader('cache-control', 'private, max-age=31536000, immutable')
    // Uploaded content served from our own origin: never let a browser sniff it into HTML.
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-disposition', 'inline')
    res.end(Buffer.from(got.bytes))
  }
}
