import { Module } from '@nestjs/common'
import { LlmModule } from '../llm/llm.module'
import { ProjectsModule } from '../projects/projects.module'
import { ApplyService } from './apply.service'
import { GenerateService } from './generate.service'
import { ProposeService } from './propose.service'

/** Natural language → IR → deterministic diff → whitelisted DDL. The only way a schema changes. */
@Module({
  imports: [ProjectsModule, LlmModule],
  providers: [ApplyService, ProposeService, GenerateService],
  exports: [ApplyService, ProposeService, GenerateService],
})
export class ModelingModule {}
