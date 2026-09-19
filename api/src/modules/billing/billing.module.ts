import { Module } from '@nestjs/common'
import { AccountsModule } from '../accounts/accounts.module'
import { CreditsModule } from '../credits/credits.module'
import { BillingController } from './billing.controller'
import { BillingService } from './billing.service'
import { RatesService } from './rates.service'

@Module({
  imports: [CreditsModule, AccountsModule],
  controllers: [BillingController],
  providers: [BillingService, RatesService],
  exports: [BillingService, RatesService],
})
export class BillingModule {}
