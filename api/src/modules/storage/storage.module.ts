import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { StorageService } from './storage.service'
import { AttachmentsService } from './attachments.service'
import { FilesController } from './files.controller'
import { AvatarsService } from './avatars.service'
import { AvatarsController } from './avatars.controller'
import { CoversService } from './covers.service'
import { SandboxModule } from '../sandbox/sandbox.module'

@Module({
  imports: [AuthModule, SandboxModule],
  controllers: [FilesController, AvatarsController],
  providers: [StorageService, AttachmentsService, AvatarsService, CoversService],
  exports: [StorageService, AttachmentsService, AvatarsService, CoversService],
})
export class StorageModule {}
