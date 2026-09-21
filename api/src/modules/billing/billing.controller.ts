import { Controller, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { ConfigService } from '../../config/config.service'
import { rawBody } from '../../common/http'
import { Public } from '../../common/public.decorator'
import { BillingService } from './billing.service'

/** Stripe subscriptions and credit packs. Unsigned requests are rejected; the raw body is what is signed. */
@Public()
@Controller('api/billing')
export class BillingController {
  constructor(private readonly billing: BillingService, private readonly cfg: ConfigService) {}

  @Post('webhook')
  async webhook(@Req() req: Request, @Res() res: Response) {
    const secret = this.cfg.env.STRIPE_WEBHOOK_SECRET
    if (!secret) return void res.status(501).send('billing disabled')
    const payload = (await rawBody(req)).toString('utf8')
    if (!(await this.billing.verifySignature(payload, req.headers['stripe-signature'] as string | null, secret)))
      return void res.status(400).send('bad signature')
    res.json({ handled: await this.billing.apply(JSON.parse(payload)) })
  }
}
