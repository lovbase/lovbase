import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import type { Request } from 'express'
import { requestHeaders } from '../../common/http'
import { TooManyRequests, Unauthorized } from '../../common/errors'
import { AccessService } from '../auth/access.service'
import { LimitsService } from '../limits/limits.service'
import { ProjectsService } from '../projects/projects.service'
import type { Project } from '../projects/project.types'

export type WorkspaceRequest = Request & { workspace: Project }

/**
 * Auth for the public data API: `Authorization: Bearer <api_token>`, or the owner's session cookie.
 * The route cannot run without a resolved workspace on the request, so there is no path into a
 * handler that skipped the check.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    private readonly projects: ProjectsService,
    private readonly access: AccessService,
    private readonly limits: LimitsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<WorkspaceRequest>()
    const projectId = String(req.params.workspaceId)
    if (!this.limits.allowRequest(projectId)) throw new TooManyRequests('too many requests for this workspace, slow down')

    const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
    if (bearer) {
      const p = await this.projects.findByApiToken(bearer)
      if (!p || p.id !== projectId) throw new Unauthorized('invalid token')
      req.workspace = p
      return true
    }
    const user = await this.access.currentUser(requestHeaders(req))
    if (user) {
      const p = await this.projects.find(projectId)
      if (p && p.owner_id === user.id) {
        req.workspace = await this.projects.ensureApiToken(p)
        return true
      }
    }
    throw new Unauthorized('missing Authorization: Bearer <api_token>')
  }
}

/** The workspace the guard resolved. */
export const workspaceOf = (req: WorkspaceRequest) => req.workspace
