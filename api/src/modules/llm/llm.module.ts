import { BillingModule } from '../billing/billing.module'
import { Module } from '@nestjs/common'
import { AccountsModule } from '../accounts/accounts.module'
import { LlmService } from './llm.service'

@Module({ imports: [AccountsModule, BillingModule], providers: [LlmService], exports: [LlmService] })
export class LlmModule {}
