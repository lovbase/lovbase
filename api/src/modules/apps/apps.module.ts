import { Module } from '@nestjs/common'
import { AppsService } from './apps.service'

@Module({ providers: [AppsService], exports: [AppsService] })
export class AppsModule {}
