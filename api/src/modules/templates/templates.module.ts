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
@Module({
  imports: [RolesModule, ProjectsModule, LimitsModule, AccountsModule],
  providers: [TemplatesService, InventoryService, Product3dService, WorkspaceGuard],
  controllers: [InventoryController, Product3dController],
  exports: [TemplatesService, InventoryService, Product3dService],
})
export class TemplatesModule {}
