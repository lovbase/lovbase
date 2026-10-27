import { Controller, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import type { ZodType } from 'zod'
import { Public } from '../../common/public.decorator'
import { DomainError, TooManyRequests, Unauthorized } from '../../common/errors'
import { GenerationService } from '../agent/generation.service'
import { LimitsService } from '../limits/limits.service'
import { ReferencesService } from './references.service'
import { copyReferenceInput, fetchReferenceInput, readReferenceInput } from './reference-tools'
import { referenceSummary } from './reference-fetch'

/** No workspace API token or browser session can access this run-scoped Boris bridge. */
@Public()
@Controller('api/reference-tools')
export class ReferencesController {
  constructor(private readonly generation: GenerationService, private readonly references: ReferencesService,
    private readonly limits: LimitsService) {}

  private async context(req: Request) {
    const token = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
    const run = token ? await this.generation.authorize(token) : null
    if (!run) throw new Unauthorized('Active generation authorization required')
    if (!this.limits.allowRequest(`references:${run.user_id}`)) throw new TooManyRequests('Too many reference requests')
    return run
  }

  private async body(req: Request) {
    // These are selectors and URLs, never source file payloads.
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1024 * 1024) throw new DomainError('Reference request is too large')
      chunks.push(Buffer.from(chunk))
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new DomainError('Invalid reference request JSON') }
  }

  private async input<T>(req: Request, schema: ZodType<T>): Promise<T> {
    const result = schema.safeParse(await this.body(req))
    if (!result.success) throw new DomainError(`Invalid reference request: ${result.error.issues[0]?.message ?? 'Invalid input'}`)
    return result.data
  }

  @Post('fetch')
  async fetch(@Req() req: Request) {
    const run = await this.context(req)
    await this.limits.assertAccount(run.user_id)
    const { url } = await this.input(req, fetchReferenceInput)
    return referenceSummary(await this.references.fetch(run.project_id, url))
  }

  @Post('read')
  async read(@Req() req: Request) {
    const run = await this.context(req)
    const { id, path, offset, limit } = await this.input(req, readReferenceInput)
    return this.references.read(run.project_id, id, path, offset, limit)
  }

  @Post('copy')
  async copy(@Req() req: Request) {
    const run = await this.context(req)
    await this.limits.assertAccount(run.user_id)
    const { id, paths, destination } = await this.input(req, copyReferenceInput)
    // The trusted extension writes these locally, inside the caller's existing sandbox lease.
    // No HTTP process may acquire/override the worker's active lease to perform this copy.
    return { files: await this.references.prepareCopy(run.project_id, id, paths, destination) }
  }
}
