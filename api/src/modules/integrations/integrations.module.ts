import { Module } from '@nestjs/common'
import { ProjectsModule } from '../projects/projects.module'
import { ModelingModule } from '../modeling/modeling.module'
import { JobsModule } from '../jobs/jobs.module'
import { LlmModule } from '../llm/llm.module'
import { CreditsModule } from '../credits/credits.module'
import { ComposioService } from './composio.service'
import { ConnectionsService } from './connections.service'
import { SheetImportsService } from './sheet-imports.service'
import { IntegrationsController } from './integrations.controller'

@Module({
  imports: [ProjectsModule, ModelingModule, JobsModule, LlmModule, CreditsModule],
  providers: [ComposioService, ConnectionsService, SheetImportsService],
  controllers: [IntegrationsController],
  exports: [ConnectionsService, SheetImportsService],
})
export class IntegrationsModule {}
