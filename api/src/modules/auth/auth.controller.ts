import { All, Controller, Inject, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { Public } from '../../common/public.decorator'
import { toFetchRequest, sendFetchResponse } from '../../common/http'
import { BETTER_AUTH, type BetterAuth } from './auth.provider'

/** Better Auth ships its own fetch-style router; this hands the whole subtree to it. */
@Controller('api/auth')
export class AuthController {
  constructor(@Inject(BETTER_AUTH) private readonly auth: BetterAuth) {}

  @Public()
  @All('*path')
  async handle(@Req() req: Request, @Res() res: Response) {
    sendFetchResponse(res, await this.auth.handler(await toFetchRequest(req)))
  }
}
