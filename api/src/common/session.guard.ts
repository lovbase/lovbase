import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { AccessService, type SessionUser } from '../modules/auth/access.service'
import { requestHeaders } from './http'
import { IS_PUBLIC } from './public.decorator'

/**
 * Applied globally in `bootstrap.ts`. A route is authenticated unless it carries `@Public()`, so
 * the failure mode of forgetting to think about auth is a locked door, not an open one.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly access: AccessService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])
    if (isPublic) return true
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>()
    const { user } = await this.access.requireUser(requestHeaders(req))
    req.user = user
    return true
  }
}
