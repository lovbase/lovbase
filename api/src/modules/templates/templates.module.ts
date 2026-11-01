import { Module } from '@nestjs/common'
import { RolesModule } from '../roles/roles.module'
import { ProjectsModule } from '../projects/projects.module'
import { LimitsModule } from '../limits/limits.module'
import { AccountsModule } from '../accounts/accounts.module'
import { WorkspaceGuard } from '../data/workspace.guard'
import { InventoryController, Product3dController } from './templates.controller'
import { TemplatesService } from './templates.service'
import { InventoryService } from './inventory.service'
import { Product3dService } from './product-3d.service'
import { CommunityTemplatesService } from './community.service'
import { ModelingModule } from '../modeling/modeling.module'
import { AppsModule } from '../apps/apps.module'
@Module({
  imports: [RolesModule, ProjectsModule, LimitsModule, AccountsModule, ModelingModule, AppsModule],
  providers: [TemplatesService, InventoryService, Product3dService, CommunityTemplatesService, WorkspaceGuard],
  controllers: [InventoryController, Product3dController],
  exports: [TemplatesService, InventoryService, Product3dService, CommunityTemplatesService],
})
export class TemplatesModule {}
