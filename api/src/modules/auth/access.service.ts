import { Inject, Injectable } from '@nestjs/common'
import type { Plan } from '@lovbase/core/plans'
import { ConfigService } from '../../config/config.service'
import { Forbidden, NotFound, Unauthorized } from '../../common/errors'
import { AccountsService } from '../accounts/accounts.service'
import { AppsService, type App } from '../apps/apps.service'
import { ProjectsService } from '../projects/projects.service'
import type { Project } from '../projects/project.types'
import { BETTER_AUTH, type BetterAuth } from './auth.provider'

export type SessionUser = { id: string; email: string; name: string; isAdmin: boolean; plan: Plan }

/** Everything downstream needs an authenticated caller; these contexts are the only way to get one. */
export type UserCtx = { user: SessionUser }
export type ProjectCtx = UserCtx & { project: Project }
export type AppCtx = ProjectCtx & { app: App }

/**
 * The one place authorization happens.
 *
 * Callers hand in the request headers and get back a context they could not have constructed
 * themselves, so a service that needs a project cannot be reached without an ownership check
 * having run first — forgetting it is a type error rather than a missing line.
 */
@Injectable()
export class AccessService {
  constructor(
    @Inject(BETTER_AUTH) private readonly auth: BetterAuth,
    private readonly accounts: AccountsService,
    private readonly projects: ProjectsService,
    private readonly apps: AppsService,
    private readonly cfg: ConfigService,
  ) {}

  /** The signed-in user, or null. Never throws. */
  async currentUser(headers: Headers): Promise<SessionUser | null> {
    const s = await this.auth.api.getSession({ headers })
    if (!s) return null
    const acct = (await this.accounts.get(s.user.id)) ?? { isAdmin: false, plan: 'free' as Plan }
    // Bootstrap: emails listed in ADMIN_EMAILS become admins on their next request.
    if (!acct.isAdmin && this.cfg.adminEmails.includes(s.user.email.toLowerCase())) {
      await this.accounts.promoteAdmin(s.user.id)
      acct.isAdmin = true
    }
    return { id: s.user.id, email: s.user.email, name: s.user.name, isAdmin: acct.isAdmin, plan: acct.plan }
  }

  async requireUser(headers: Headers): Promise<UserCtx> {
    const user = await this.currentUser(headers)
    if (!user) throw new Unauthorized()
    return { user }
  }

  async requireAdmin(headers: Headers): Promise<UserCtx> {
    const { user } = await this.requireUser(headers)
    if (!user.isAdmin) throw new Forbidden('需要管理员权限')
    return { user }
  }

  /** Ownership check against the session, never against a client-sent id alone. */
  async requireProject(headers: Headers, projectId: string): Promise<ProjectCtx> {
    const { user } = await this.requireUser(headers)
    const project = await this.projects.find(projectId)
    if (!project || project.owner_id !== user.id) throw new NotFound('项目不存在')
    return { user, project }
  }

  async requireApp(headers: Headers, projectId: string, appId: string): Promise<AppCtx> {
    const ctx = await this.requireProject(headers, projectId)
    const app = await this.apps.find(ctx.project.id, appId)
    if (!app) throw new NotFound('应用不存在')
    return { ...ctx, app }
  }

  /** A share link is its own capability: read and add rows, never change structure. */
  async requireShared(token: string): Promise<Project> {
    const p = await this.projects.findByShareToken(token)
    if (!p) throw new NotFound('分享链接不存在或已关闭')
    return p
  }
}
