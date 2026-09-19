import { Module } from '@nestjs/common'
import { AccountsModule } from '../accounts/accounts.module'
import { LlmService } from './llm.service'

@Module({ imports: [AccountsModule], providers: [LlmService], exports: [LlmService] })
export class LlmModule {}
