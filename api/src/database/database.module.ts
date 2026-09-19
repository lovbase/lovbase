import { Global, Module } from '@nestjs/common'
import { PoolCloser, poolProviders } from './pool.provider'
import { SchemaService } from './schema.service'

@Global()
@Module({
  providers: [...poolProviders, SchemaService, PoolCloser],
  exports: [...poolProviders.map((p) => (p as { provide: symbol }).provide), SchemaService],
})
export class DatabaseModule {}
