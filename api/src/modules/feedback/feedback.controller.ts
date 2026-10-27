import { Controller, Get, Param, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { requestHeaders } from '../../common/http'
import { AccessService } from '../auth/access.service'
import { FeedbackService } from './feedback.service'
import { NotFound } from '../../common/errors'

@Controller('api/feedback')
export class FeedbackController {
  constructor(private readonly access: AccessService, private readonly feedback: FeedbackService) {}

  @Get(':id/images/:position')
  async image(@Req() req: Request, @Res() res: Response, @Param('id') id: string, @Param('position') position: string) {
    const ctx = await this.access.requireUser(requestHeaders(req))
    if (!/^[0-2]$/.test(position)) throw new NotFound('Screenshot not found')
    const image = await this.feedback.image(ctx, id, Number(position))
    res.set({ 'Content-Type': image.content_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).send(image.bytes)
  }
}
