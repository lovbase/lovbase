import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common'
import type { Response } from 'express'
import { DomainError } from './errors'

/** One place where a thrown domain error becomes a response body. Controllers never map statuses. */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('http')

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>()
    if (err instanceof DomainError) return void res.status(err.status).json({ error: err.message })
    if (err instanceof HttpException) {
      const body = err.getResponse()
      return void res.status(err.getStatus()).json(typeof body === 'string' ? { error: body } : body)
    }
    // Anything unrecognised is ours, not the caller's: log it and say nothing useful to a stranger.
    this.log.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
    res.status(500).json({ error: '服务器内部错误' })
  }
}
