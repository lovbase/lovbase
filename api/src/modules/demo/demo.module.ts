import { Module } from '@nestjs/common'
import { ModelingModule } from '../modeling/modeling.module'
import { ProjectsModule } from '../projects/projects.module'
import { RolesModule } from '../roles/roles.module'
import { SandboxModule } from '../sandbox/sandbox.module'
import { DemoService } from './demo.service'

@Module({
  imports: [ProjectsModule, ModelingModule, RolesModule, SandboxModule],
  providers: [DemoService],
  exports: [DemoService],
})
export class DemoModule {}
