import { GenerationService } from './generation.service'
import { IntegrationsModule } from '../integrations/integrations.module'
import { Module } from '@nestjs/common'
import { AppsModule } from '../apps/apps.module'
import { BillingModule } from '../billing/billing.module'
import { StorageModule } from '../storage/storage.module'
import { CreditsModule } from '../credits/credits.module'
import { LlmModule } from '../llm/llm.module'
import { ModelingModule } from '../modeling/modeling.module'
import { ProjectsModule } from '../projects/projects.module'
import { RolesModule } from '../roles/roles.module'
import { SandboxModule } from '../sandbox/sandbox.module'
import { SqlModule } from '../sql/sql.module'
import { AgentService } from './agent.service'
import { ChatController } from './chat.controller'
import { LlmRelayController } from './llm-relay.controller'
import { NamingService } from './naming.service'
import { SkillsService } from './skills.service'
import { TurnService } from './turn.service'
import { JobsModule } from '../jobs/jobs.module'
import { ReferencesService } from '../references/references.service'
import { ReferencesController } from '../references/references.controller'

@Module({
  imports: [IntegrationsModule, ProjectsModule, AppsModule, RolesModule, SqlModule, ModelingModule, SandboxModule, CreditsModule, LlmModule, BillingModule, StorageModule, JobsModule],
  controllers: [ChatController, LlmRelayController, ReferencesController],
  providers: [GenerationService, AgentService, NamingService, SkillsService, TurnService, ReferencesService],
  exports: [GenerationService, AgentService, NamingService, SkillsService, TurnService],
})
export class AgentModule {}
