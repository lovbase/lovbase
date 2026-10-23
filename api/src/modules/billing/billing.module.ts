import { ModelMeterService } from './model-meter.service'
import { JobsModule } from '../jobs/jobs.module'
import { Module } from '@nestjs/common'
import { AccountsModule } from '../accounts/accounts.module'
import { CreditsModule } from '../credits/credits.module'
import { BillingController } from './billing.controller'
import { BillingService } from './billing.service'
import { RatesService } from './rates.service'
import { RefundsService } from './refunds.service'

@Module({
  imports: [CreditsModule, AccountsModule, JobsModule],
  controllers: [BillingController],
  providers: [BillingService, RefundsService, RatesService, ModelMeterService],
  exports: [BillingService, RefundsService, RatesService, ModelMeterService],
})
export class BillingModule {}
