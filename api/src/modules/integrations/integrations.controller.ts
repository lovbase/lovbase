import { Controller, Get, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { AccessService } from '../auth/access.service'
import { requestHeaders } from '../../common/http'
import { ConnectionsService } from './connections.service'

@Controller('api/integrations/google')
export class IntegrationsController {
  constructor(private readonly access: AccessService, private readonly connections: ConnectionsService) {}
  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const ctx = await this.access.requireUser(requestHeaders(req))
    const input = z.object({ state: z.string().min(20), connected_account_id: z.string(), status: z.enum(['success', 'failed']) }).parse(req.query)
    const path = await this.connections.complete(ctx, input.state, input.connected_account_id, input.status)
    res.set('Cache-Control', 'no-store').redirect(path)
  }
}
