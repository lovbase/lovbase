import { Controller, Get, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { AccessService } from '../auth/access.service'
import { requestHeaders } from '../../common/http'
import { Public } from '../../common/public.decorator'
import { McpService } from './mcp.service'

@Controller('api/integrations/mcp')
export class McpController {
  constructor(private readonly access: AccessService, private readonly mcp: McpService) {}

  @Get('client-metadata')
  @Public()
  metadata(@Res() res: Response) {
    res.set('Cache-Control', 'public, max-age=300').json(this.mcp.clientMetadataDocument)
  }

  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    const ctx = await this.access.requireUser(requestHeaders(req))
    const input = z.object({ state: z.string().min(20).max(200), code: z.string().max(4096).optional(), error: z.string().max(200).optional() }).parse(req.query)
    const path = await this.mcp.completeOAuth(ctx, input)
    res.redirect(path)
  }
}
