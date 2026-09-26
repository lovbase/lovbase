import { Module } from '@nestjs/common'
import { SandboxService } from './sandbox.service'
import { SandboxLeaseService } from './sandbox-lease.service'

@Module({ providers: [SandboxService, SandboxLeaseService], exports: [SandboxService, SandboxLeaseService] })
export class SandboxModule {}
