import { ModelMeterService } from './model-meter.service'
import { JobsModule } from '../jobs/jobs.module'
import { Module } from '@nestjs/common'
import { AccountsModule } from '../accounts/accounts.module'
import { CreditsModule } from '../credits/credits.module'
import { BillingController } from './billing.controller'
import { BillingService } from './billing.service'
import { RatesService } from './rates.service'

@Module({
  imports: [CreditsModule, AccountsModule, JobsModule],
  controllers: [BillingController],
  providers: [BillingService, RatesService, ModelMeterService],
  exports: [BillingService, RatesService, ModelMeterService],
})
export class BillingModule {}
