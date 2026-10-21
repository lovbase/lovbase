import { Module } from '@nestjs/common'
import { AccountsModule } from '../accounts/accounts.module'
import { AppsModule } from '../apps/apps.module'
import { ProjectsModule } from '../projects/projects.module'
import { DevelopmentModule } from '../development/development.module'
import { SqlModule } from '../sql/sql.module'
import { RolesModule } from '../roles/roles.module'
import { LimitsModule } from '../limits/limits.module'
import { ModelingModule } from '../modeling/modeling.module'
import { CreditsModule } from '../credits/credits.module'
import { LlmModule } from '../llm/llm.module'
import { JobsModule } from '../jobs/jobs.module'
import { McpOAuthService } from './oauth.service'
import { McpToolsService } from './tools.service'
@Module({ imports: [AccountsModule, AppsModule, ProjectsModule, DevelopmentModule, SqlModule, RolesModule, LimitsModule, ModelingModule, CreditsModule, LlmModule, JobsModule],
  providers: [McpOAuthService, McpToolsService], exports: [McpOAuthService, McpToolsService] })
export class McpServerModule {}
