import { Module } from '@nestjs/common'
import { RolesModule } from '../roles/roles.module'
import { ConversationService } from './conversation.service'
import { FoldersService } from './folders.service'
import { ProjectsService } from './projects.service'
import { RunStreamService } from './run-stream.service'

@Module({
  imports: [RolesModule],
  providers: [ProjectsService, FoldersService, ConversationService, RunStreamService],
  exports: [ProjectsService, FoldersService, ConversationService, RunStreamService],
})
export class ProjectsModule {}
