import { Module } from '@nestjs/common'
import { AccountsModule } from '../accounts/accounts.module'
import { LimitsModule } from '../limits/limits.module'
import { LlmModule } from '../llm/llm.module'
import { ModelingModule } from '../modeling/modeling.module'
import { ProjectsModule } from '../projects/projects.module'
import { RolesModule } from '../roles/roles.module'
import { SqlModule } from '../sql/sql.module'
import { DataController } from './data.controller'
import { RowsService } from './rows.service'
import { WorkspaceGuard } from './workspace.guard'

@Module({
  imports: [ProjectsModule, AccountsModule, RolesModule, SqlModule, LimitsModule, LlmModule, ModelingModule],
  controllers: [DataController],
  providers: [RowsService, WorkspaceGuard],
  exports: [RowsService],
})
export class DataModule {}
