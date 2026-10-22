import { StorageQuotaController } from './storage-quota.controller'
import { Global, Module } from '@nestjs/common'
import { LimitsService } from './limits.service'

@Global()
@Module({ controllers:[StorageQuotaController], providers: [LimitsService], exports: [LimitsService] })
export class LimitsModule {}
