import { Controller, Get, Options, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { Public } from '../../common/public.decorator'
import { DATA_CORS } from '../../common/cors'
import { jsonBody, sendJson } from '../../common/http'
import { WorkspaceGuard, type WorkspaceRequest } from '../data/workspace.guard'
import { InventoryService } from './inventory.service'
import { Product3dService } from './product-3d.service'
import { LimitsService } from '../limits/limits.service'
import { AccountsService } from '../accounts/accounts.service'

@Public()
@Controller('api/data/:workspaceId/inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly limits: LimitsService,
    private readonly accounts: AccountsService,
  ) {}
  @Options()
  options(@Res() res: Response) {
    res.status(204).set(DATA_CORS).end()
  }
  @Get()
  @UseGuards(WorkspaceGuard)
  async read(@Req() req: WorkspaceRequest, @Res() res: Response) {
    res.set(DATA_CORS)
    sendJson(res, await this.inventory.read(req.workspace.id), 200, DATA_CORS)
  }
  @Post()
  @UseGuards(WorkspaceGuard)
  async write(@Req() req: WorkspaceRequest, @Res() res: Response) {
    res.set(DATA_CORS)
    const account = await this.accounts.get(req.workspace.owner_id)
    await this.limits.assertWithinQuota(req.workspace.id, account?.plan ?? 'free')
    sendJson(
      res,
      await this.inventory.command(
        req.workspace.id,
        await jsonBody(req, 'Invalid inventory command'),
      ),
      200,
      DATA_CORS,
    )
  }
}

@Public()
@Controller('api/data/:workspaceId/product-3d')
export class Product3dController {
  constructor(
    private readonly product3d: Product3dService,
    private readonly limits: LimitsService,
    private readonly accounts: AccountsService,
  ) {}
  @Options()
  options(@Res() res: Response) {
    res.status(204).set(DATA_CORS).end()
  }
  @Get()
  @UseGuards(WorkspaceGuard)
  async read(@Req() req: WorkspaceRequest, @Res() res: Response) {
    res.set(DATA_CORS)
    sendJson(res, await this.product3d.read(req.workspace.id), 200, DATA_CORS)
  }
  @Post()
  @UseGuards(WorkspaceGuard)
  async write(@Req() req: WorkspaceRequest, @Res() res: Response) {
    res.set(DATA_CORS)
    const account = await this.accounts.get(req.workspace.owner_id)
    await this.limits.assertWithinQuota(req.workspace.id, account?.plan ?? 'free')
    sendJson(
      res,
      await this.product3d.command(
        req.workspace.id,
        await jsonBody(req, 'Invalid product configuration command'),
      ),
      200,
      DATA_CORS,
    )
  }
}
