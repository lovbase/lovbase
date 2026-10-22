import { AuthModule } from '../auth/auth.module'
import { ExportsService } from './exports.service'
import { ExportsController } from './exports.controller'
import { Global, Module } from '@nestjs/common'
import { DirectDatabaseService } from './direct-database.service'

@Global()
@Module({
  imports: [AuthModule],
  controllers: [ExportsController],
  providers: [DirectDatabaseService, ExportsService],
  exports: [DirectDatabaseService, ExportsService],
})
export class EntitlementsModule {}
