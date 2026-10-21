import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { AccessService } from '../auth/access.service'
import { jsonBody, requestHeaders } from '../../common/http'
import { ConnectionsService } from './connections.service'
import { McpService } from './mcp.service'

@Controller(['api/integrations', 'api/integrations/google'])
export class IntegrationsController {
  constructor(private readonly access: AccessService, private readonly connections: ConnectionsService, private readonly mcp: McpService) {}
  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const ctx = await this.access.requireUser(requestHeaders(req))
    const input = z.object({ state: z.string().min(20), connected_account_id: z.string().optional(), status: z.enum(['success', 'failed']) }).parse(req.query)
    const path = await this.connections.complete(ctx, input.state, input.connected_account_id, input.status)
    res.set('Cache-Control', 'no-store').redirect(path)
  }

  @Get('mcp/registries')
  async mcpRegistries(@Req() req: Request) { return this.mcp.listRegistries(await this.access.requireUser(requestHeaders(req))) }

  @Post('mcp/registries')
  async createMcpRegistry(@Req() req: Request) {
    const ctx = await this.access.requireUser(requestHeaders(req))
    return this.mcp.createRegistry(ctx, await jsonBody<{ url: string; displayName?: string; bearerToken?: string }>(req, 'bad json'))
  }

  @Post('mcp/registries/:id/sync')
  async syncMcpRegistry(@Req() req: Request, @Param('id') id: string) {
    return this.mcp.syncRegistry(await this.access.requireUser(requestHeaders(req)), id)
  }

  @Post('mcp/registries/:id/delete')
  async deleteMcpRegistry(@Req() req: Request, @Param('id') id: string) {
    return this.mcp.deleteRegistry(await this.access.requireUser(requestHeaders(req)), id)
  }
}
