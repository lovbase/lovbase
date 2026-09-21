import { Module } from '@nestjs/common'
import { InterestService } from './interest.service'

@Module({ providers: [InterestService], exports: [InterestService] })
export class InterestModule {}
