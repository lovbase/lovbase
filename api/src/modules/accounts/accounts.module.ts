import { Module } from '@nestjs/common'
import { AccountsService } from './accounts.service'
import { SettingsService } from './settings.service'
import { UserSettingsService } from './user-settings.service'

@Module({
  providers: [AccountsService, SettingsService, UserSettingsService],
  exports: [AccountsService, SettingsService, UserSettingsService],
})
export class AccountsModule {}
