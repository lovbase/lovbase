import { Global, Module } from '@nestjs/common'
import { AccountsModule } from '../accounts/accounts.module'
import { AppsModule } from '../apps/apps.module'
import { ProjectsModule } from '../projects/projects.module'
import { AccessService } from './access.service'
import { AuthController } from './auth.controller'
import { authProvider, BETTER_AUTH } from './auth.provider'

@Global()
@Module({
  imports: [AccountsModule, ProjectsModule, AppsModule],
  controllers: [AuthController],
  providers: [authProvider, AccessService],
  exports: [authProvider, BETTER_AUTH, AccessService],
})
export class AuthModule {}
