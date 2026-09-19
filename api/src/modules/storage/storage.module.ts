import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { StorageService } from './storage.service'
import { AttachmentsService } from './attachments.service'
import { FilesController } from './files.controller'

@Module({
  imports: [AuthModule],
  controllers: [FilesController],
  providers: [StorageService, AttachmentsService],
  exports: [StorageService, AttachmentsService],
})
export class StorageModule {}
