import 'reflect-metadata'
import type { INestApplication, Type } from '@nestjs/common'
import { createApi } from './bootstrap'

// ── What the web app imports ──
// The API and the React app run in one process, so the app's server functions reach Nest providers
// directly instead of making an HTTP call to themselves. `useApi` hands over the instance the HTTP
// server already created, so there is exactly one container — one set of pools, one Better Auth.
//
// Nothing here is required for the API to run on its own (see main.ts); this is only the in-process
// door, and it is the single line to delete if the two ever become separate services.

let instance: INestApplication | null = null
let booting: Promise<INestApplication> | null = null

/** Register the running application (called by the web server once, at startup). */
export function useApi(app: INestApplication) {
  instance = app
}

/** The application, bootstrapping one on first use if nobody registered one (dev, tests, scripts). */
export function api(): Promise<INestApplication> {
  if (instance) return Promise.resolve(instance)
  booting ??= createApi().then((app) => (instance = app))
  return booting
}

/** Resolve a provider. `const projects = await svc(ProjectsService)` */
export async function svc<T>(token: Type<T>): Promise<T> {
  return (await api()).get(token)
}

export { createApi } from './bootstrap'
export { AppModule } from './app.module'
export { ConfigService } from './config/config.service'

// Errors — the web app maps these to its own redirects and UI states.
export { DomainError, Forbidden, NotFound, PlanLimit, QuotaExceeded, SlugTaken, SqlError, TooManyRequests, Unauthorized } from './common/errors'

// Services and their types, grouped the way the modules are.
export { AccessService } from './modules/auth/access.service'
export type { AppCtx, ProjectCtx, SessionUser, UserCtx } from './modules/auth/access.service'
export { AccountsService } from './modules/accounts/accounts.service'
export type { Account, AccountRow } from './modules/accounts/accounts.service'
export { SettingsService } from './modules/accounts/settings.service'
export { UserSettingsService } from './modules/accounts/user-settings.service'
export type { UserSettings } from './modules/accounts/user-settings.service'
export { AgentService } from './modules/agent/agent.service'
export { SkillsService } from './modules/agent/skills.service'
export { parseActivity, summarize } from './modules/agent/boris'
export type { BorisActivity, BorisStep } from './modules/agent/boris'
export { AnalyticsService } from './modules/analytics/analytics.service'
export { AppsService } from './modules/apps/apps.service'
export { InterestService } from './modules/interest/interest.service'
export type { Intent, IntentRow } from './modules/interest/interest.service'
export { CoversService } from './modules/storage/covers.service'
export { EdgeAnalyticsService } from './modules/analytics/edge-analytics.service'
export { AttachmentsService } from './modules/storage/attachments.service'
export { FILES_PREFIX } from './modules/storage/attachments.service'
export type { App, AppFile } from './modules/apps/apps.service'
export { RESERVED_SUBDOMAINS, looksLikePreviewHost } from './modules/apps/reserved'
export { BillingService } from './modules/billing/billing.service'
export { CreditsService, OutOfCredits } from './modules/credits/credits.service'
export type { Balance, Grant, PlatformStats, TopUser, UsageRow } from './modules/credits/credits.service'
export { CryptoService } from './modules/crypto/crypto.service'
export { RowsService } from './modules/data/rows.service'
export { LimitsService } from './modules/limits/limits.service'
export { LlmService } from './modules/llm/llm.service'
export type { LlmConfig, PlatformLlm, TierLlm, TierOption } from './modules/llm/llm.service'
export { ApplyService } from './modules/modeling/apply.service'
export { GenerateService } from './modules/modeling/generate.service'
export type { HistoryItem, Turn } from './modules/modeling/generate.service'
export { ProposeService } from './modules/modeling/propose.service'
export type { ProposalResult } from './modules/modeling/propose.service'
export { ConversationService } from './modules/projects/conversation.service'
export type { RunProgress } from './modules/projects/conversation.service'
export { FoldersService } from './modules/projects/folders.service'
export type { Folder } from './modules/projects/folders.service'
export { ProjectsService, schemaFor } from './modules/projects/projects.service'
export type { LogEntry, Project } from './modules/projects/project.types'
export { RatesService } from './modules/billing/rates.service'
export { RolesService } from './modules/roles/roles.service'
export { SandboxService } from './modules/sandbox/sandbox.service'
export { SqlService } from './modules/sql/sql.service'
export type { SqlResult, TableInfo } from './modules/sql/sql.service'
export { PG_POOL, PG_SQL_POOL } from './database/pool.provider'

// The Express ⇄ fetch bridge, shared with the web server so both speak the same dialect.
export { requestHeaders, requestUrl, sendFetchResponse, toFetchRequest } from './common/http'
