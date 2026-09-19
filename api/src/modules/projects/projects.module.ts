import { Module } from '@nestjs/common'
import { RolesModule } from '../roles/roles.module'
import { ConversationService } from './conversation.service'
import { FoldersService } from './folders.service'
import { ProjectsService } from './projects.service'

@Module({
  imports: [RolesModule],
  providers: [ProjectsService, FoldersService, ConversationService],
  exports: [ProjectsService, FoldersService, ConversationService],
})
export class ProjectsModule {}
