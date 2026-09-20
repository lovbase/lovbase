import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { StorageService } from './storage.service'
import { AttachmentsService } from './attachments.service'
import { FilesController } from './files.controller'
import { AvatarsService } from './avatars.service'
import { AvatarsController } from './avatars.controller'

@Module({
  imports: [AuthModule],
  controllers: [FilesController, AvatarsController],
  providers: [StorageService, AttachmentsService, AvatarsService],
  exports: [StorageService, AttachmentsService, AvatarsService],
})
export class StorageModule {}
