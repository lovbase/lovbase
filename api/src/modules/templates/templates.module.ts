import { Module } from '@nestjs/common'
import { RolesModule } from '../roles/roles.module'
import { ProjectsModule } from '../projects/projects.module'
import { LimitsModule } from '../limits/limits.module'
import { AccountsModule } from '../accounts/accounts.module'
import { WorkspaceGuard } from '../data/workspace.guard'
import { InventoryController } from './templates.controller'
import { TemplatesService } from './templates.service'
import { InventoryService } from './inventory.service'
@Module({
  imports: [RolesModule, ProjectsModule, LimitsModule, AccountsModule],
  providers: [TemplatesService, InventoryService, WorkspaceGuard],
  controllers: [InventoryController],
  exports: [TemplatesService, InventoryService],
})
export class TemplatesModule {}
