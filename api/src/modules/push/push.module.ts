import { Global, Module } from '@nestjs/common'
import { PushController } from './push.controller'
import { PushService } from './push.service'

@Global()
@Module({ providers: [PushService], controllers: [PushController], exports: [PushService] })
export class PushModule {}
