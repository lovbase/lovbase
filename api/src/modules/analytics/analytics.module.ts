import { Module } from '@nestjs/common'
import { ProjectsModule } from '../projects/projects.module'
import { AnalyticsService } from './analytics.service'
import { EdgeAnalyticsService } from './edge-analytics.service'
import { EventsController } from './events.controller'

@Module({
  imports: [ProjectsModule],
  controllers: [EventsController],
  providers: [AnalyticsService, EdgeAnalyticsService],
  exports: [AnalyticsService, EdgeAnalyticsService],
})
export class AnalyticsModule {}
