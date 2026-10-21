import { Module } from '@nestjs/common'
import { AppsModule } from '../apps/apps.module'
import { ProjectsModule } from '../projects/projects.module'
import { SandboxModule } from '../sandbox/sandbox.module'
import { StorageModule } from '../storage/storage.module'
import { JobsModule } from '../jobs/jobs.module'
import { AppOperationsService } from './app-operations.service'
@Module({ imports: [AppsModule, ProjectsModule, SandboxModule, StorageModule, JobsModule], providers: [AppOperationsService], exports: [AppOperationsService] })
export class DevelopmentModule {}
