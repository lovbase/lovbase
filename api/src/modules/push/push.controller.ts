import { Controller, Delete, Get, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { jsonBody, requestHeaders } from '../../common/http'
import { AccessService } from '../auth/access.service'
import { PushService, type PushSubscriptionInput } from './push.service'

@Controller('api/push')
export class PushController {
  constructor(private readonly access: AccessService, private readonly push: PushService) {}

  @Get('config') config() { return { publicKey: this.push.publicKey, enabled: !!this.push.publicKey } }

  @Post('subscription')
  async subscribe(@Req() req: Request) {
    return this.push.save(await this.access.requireUser(requestHeaders(req)), await jsonBody<PushSubscriptionInput>(req, 'bad push subscription'))
  }

  @Delete('subscription')
  async unsubscribe(@Req() req: Request) {
    const body = await jsonBody<{ endpoint?: string }>(req, 'bad push subscription')
    return this.push.remove(await this.access.requireUser(requestHeaders(req)), body?.endpoint ?? '')
  }
}
