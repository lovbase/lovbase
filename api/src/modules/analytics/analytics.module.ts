import { Module } from '@nestjs/common'
import { ProjectsModule } from '../projects/projects.module'
import { AnalyticsService } from './analytics.service'
import { EventsController } from './events.controller'

@Module({
  imports: [ProjectsModule],
  controllers: [EventsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
