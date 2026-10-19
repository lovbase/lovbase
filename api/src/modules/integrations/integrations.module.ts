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
import { McpController } from './mcp.controller'
import { McpService } from './mcp.service'

@Module({
  imports: [ProjectsModule, ModelingModule, JobsModule, LlmModule, CreditsModule],
  providers: [ComposioService, ConnectionsService, SheetImportsService, McpService],
  controllers: [IntegrationsController, McpController],
  exports: [ConnectionsService, SheetImportsService, McpService],
})
export class IntegrationsModule {}
