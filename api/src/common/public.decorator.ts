import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import { requestHeaders } from './http'
import type { SessionUser } from '../modules/auth/access.service'

/**
 * Opt out of the global session guard. Everything is authenticated unless it says otherwise, so a
 * new endpoint is private by accident rather than public by accident.
 */
export const IS_PUBLIC = 'lovbase:public'
export const Public = () => SetMetadata(IS_PUBLIC, true)

/** The user the guard resolved. Only present on guarded routes. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionUser =>
  ctx.switchToHttp().getRequest<Request & { user: SessionUser }>().user)

/** Request headers as a fetch `Headers`, which is what AccessService takes. */
export const ReqHeaders = createParamDecorator((_: unknown, ctx: ExecutionContext): Headers =>
  requestHeaders(ctx.switchToHttp().getRequest<Request>()))
