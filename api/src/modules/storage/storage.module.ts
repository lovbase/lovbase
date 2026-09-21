import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { StorageService } from './storage.service'
import { AttachmentsService } from './attachments.service'
import { FilesController } from './files.controller'
import { SnapshotController } from './snapshot.controller'
import { AvatarsService } from './avatars.service'
import { AvatarsController } from './avatars.controller'
import { CoversService } from './covers.service'
import { SandboxModule } from '../sandbox/sandbox.module'
import { AppsModule } from '../apps/apps.module'

@Module({
  imports: [AuthModule, SandboxModule, AppsModule],
  controllers: [FilesController, AvatarsController, SnapshotController],
  providers: [StorageService, AttachmentsService, AvatarsService, CoversService],
  exports: [StorageService, AttachmentsService, AvatarsService, CoversService],
})
export class StorageModule {}
