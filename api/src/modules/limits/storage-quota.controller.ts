import { Controller, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { Public } from '../../common/public.decorator'
import { jsonBody } from '../../common/http'
import { Unauthorized } from '../../common/errors'
import { ConfigService } from '../../config/config.service'
import { LimitsService } from './limits.service'

const Input = z.object({
  appId: z.string(),
  category: z.enum(['build', 'published']),
  phase: z.enum(['reserve', 'commit', 'abort']),
  bytes: z.number().int().nonnegative().optional(),
  reservation: z.string().optional(),
})
@Public()
@Controller('api/internal/storage-quota')
export class StorageQuotaController {
  constructor(
    private readonly cfg: ConfigService,
    private readonly limits: LimitsService,
  ) {}
  @Post()
  async quota(@Req() req: Request) {
    const received = Buffer.from(req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''),
      expected = Buffer.from(this.cfg.env.SANDBOX_INTERNAL_TOKEN)
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Unauthorized()
    const d = Input.parse(await jsonBody(req, 'Invalid storage request'))
    return this.limits.sandboxQuota(d)
  }
}
