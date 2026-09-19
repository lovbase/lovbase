import { Module } from '@nestjs/common'
import { IngestController } from './ingest.controller'

@Module({ controllers: [IngestController] })
export class IngestModule {}
