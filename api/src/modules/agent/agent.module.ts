import { Module } from '@nestjs/common'
import { AppsModule } from '../apps/apps.module'
import { BillingModule } from '../billing/billing.module'
import { CreditsModule } from '../credits/credits.module'
import { LlmModule } from '../llm/llm.module'
import { ModelingModule } from '../modeling/modeling.module'
import { ProjectsModule } from '../projects/projects.module'
import { RolesModule } from '../roles/roles.module'
import { SandboxModule } from '../sandbox/sandbox.module'
import { SqlModule } from '../sql/sql.module'
import { AgentService } from './agent.service'
import { ChatController } from './chat.controller'
import { SkillsService } from './skills.service'

@Module({
  imports: [ProjectsModule, AppsModule, RolesModule, SqlModule, ModelingModule, SandboxModule, CreditsModule, LlmModule, BillingModule],
  controllers: [ChatController],
  providers: [AgentService, SkillsService],
  exports: [AgentService, SkillsService],
})
export class AgentModule {}
