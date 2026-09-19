import { Module } from '@nestjs/common'
import { SandboxService } from './sandbox.service'

@Module({ providers: [SandboxService], exports: [SandboxService] })
export class SandboxModule {}
