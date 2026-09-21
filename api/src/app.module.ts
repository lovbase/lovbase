import { Module } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { ConfigModule } from './config/config.module'
import { DatabaseModule } from './database/database.module'
import { DomainErrorFilter } from './common/errors.filter'
import { SessionGuard } from './common/session.guard'
import { AccountsModule } from './modules/accounts/accounts.module'
import { AgentModule } from './modules/agent/agent.module'
import { AnalyticsModule } from './modules/analytics/analytics.module'
import { AppsModule } from './modules/apps/apps.module'
import { InterestModule } from './modules/interest/interest.module'
import { AuthModule } from './modules/auth/auth.module'
import { BillingModule } from './modules/billing/billing.module'
import { CreditsModule } from './modules/credits/credits.module'
import { StorageModule } from './modules/storage/storage.module'
import { CryptoModule } from './modules/crypto/crypto.module'
import { DataModule } from './modules/data/data.module'
import { IngestModule } from './modules/ingest/ingest.module'
import { LimitsModule } from './modules/limits/limits.module'
import { LlmModule } from './modules/llm/llm.module'
import { ModelingModule } from './modules/modeling/modeling.module'
import { ProjectsModule } from './modules/projects/projects.module'
import { RolesModule } from './modules/roles/roles.module'
import { SandboxModule } from './modules/sandbox/sandbox.module'
import { SqlModule } from './modules/sql/sql.module'

/**
 * The whole backend. Config, database and auth are global because everything needs them; the rest
 * declares its own dependencies, so what a module may reach is visible in one place — which is the
 * point of having modules at all.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CryptoModule,
    AuthModule,
    AccountsModule,
    ProjectsModule,
    AppsModule,
    InterestModule,
    RolesModule,
    SqlModule,
    LimitsModule,
    LlmModule,
    ModelingModule,
    DataModule,
    SandboxModule,
    CreditsModule,
    StorageModule,
    AgentModule,
    AnalyticsModule,
    BillingModule,
    IngestModule,
  ],
  providers: [
    // Authenticated by default; a route opts out with `@Public()`. Forgetting to think about auth
    // locks the door rather than leaving it open.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
export class AppModule {}
