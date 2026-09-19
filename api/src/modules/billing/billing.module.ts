import { Module } from '@nestjs/common'
import { CreditsModule } from '../credits/credits.module'
import { BillingController } from './billing.controller'
import { BillingService } from './billing.service'

@Module({
  imports: [CreditsModule],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
