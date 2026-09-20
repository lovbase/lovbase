import { Controller, Delete, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { rawBody, requestHeaders } from '../../common/http'
import { AccessService } from '../auth/access.service'
import { AvatarsService, MAX_AVATAR_BYTES } from './avatars.service'

/**
 * Uploading and clearing your own avatar.
 *
 * The body is the image itself rather than a multipart form: there is exactly one file, the
 * browser can send a File as a body directly, and multipart would mean a parser in the request
 * path for no gain. The route never takes a user id — it is always the caller's own picture, so
 * there is no id to get wrong.
 */
@Controller('api/avatar')
export class AvatarsController {
  constructor(
    private readonly access: AccessService,
    private readonly avatars: AvatarsService,
  ) {}

  @Post()
  async upload(@Req() req: Request, @Res() res: Response) {
    const { user } = await this.access.requireUser(requestHeaders(req))

    // Refuse on the declared length before reading, so an oversized body is not pulled into memory
    // just to be rejected. The check after the read is the one that counts — the header can lie.
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > MAX_AVATAR_BYTES) return void res.status(413).json({ error: '头像不能超过 2MB' })

    const body = await rawBody(req)
    try {
      const url = await this.avatars.set(user.id, new Uint8Array(body), String(req.headers['content-type'] ?? ''))
      res.json({ url })
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : '上传失败' })
    }
  }

  @Delete()
  async clear(@Req() req: Request, @Res() res: Response) {
    const { user } = await this.access.requireUser(requestHeaders(req))
    await this.avatars.clear(user.id)
    res.json({ url: null })
  }
}
