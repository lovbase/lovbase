import { Module } from '@nestjs/common'
import { AppModule } from './app.module'
import { WorkerRuntimeModule } from './modules/jobs/worker.module'

@Module({ imports: [AppModule, WorkerRuntimeModule] })
export class WorkerAppModule {}
