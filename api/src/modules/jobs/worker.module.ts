import { Module } from '@nestjs/common'
import { AgentModule } from '../agent/agent.module'
import { AppsModule } from '../apps/apps.module'
import { BillingModule } from '../billing/billing.module'
import { LlmModule } from '../llm/llm.module'
import { ProjectsModule } from '../projects/projects.module'
import { StorageModule } from '../storage/storage.module'
import { SandboxModule } from '../sandbox/sandbox.module'
import { JobsModule } from './jobs.module'
import { WorkerRuntimeService } from './worker-runtime.service'

@Module({
  imports: [JobsModule, AgentModule, ProjectsModule, AppsModule, LlmModule, BillingModule, StorageModule, SandboxModule],
  providers: [WorkerRuntimeService],
})
export class WorkerRuntimeModule {}
