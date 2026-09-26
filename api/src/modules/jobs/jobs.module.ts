import { Module } from '@nestjs/common'
import { JobQueueService } from './job-queue.service'
import { JobRepository } from './job.repository'

@Module({
  providers: [JobRepository, JobQueueService],
  exports: [JobRepository, JobQueueService],
})
export class JobsModule {}
