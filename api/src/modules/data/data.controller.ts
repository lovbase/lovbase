import { Controller, Get, Options, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { irToDDL } from '@lovbase/core/ddl'
import { DATA_CORS } from '../../common/cors'
import { DomainError } from '../../common/errors'
import { jsonBody, sendJson } from '../../common/http'
import { Public } from '../../common/public.decorator'
import { LimitsService } from '../limits/limits.service'
import { LlmService } from '../llm/llm.service'
import { AccountsService } from '../accounts/accounts.service'
import { GenerateService } from '../modeling/generate.service'
import { ProposeService } from '../modeling/propose.service'
import { ProjectsService, schemaFor } from '../projects/projects.service'
import { RolesService } from '../roles/roles.service'
import { SqlService } from '../sql/sql.service'
import { WorkspaceGuard, type WorkspaceRequest } from './workspace.guard'

// ── The public data API for one workspace ──
// This is what generated apps and third-party agents talk to. Its safety boundary is Postgres
// permissions (see SqlService), not SQL parsing, and schema changes only ever happen through
// POST /schema — destructive ones stop and wait for the owner.
//
// `/w/:workspaceId/*` is the original path, kept working for apps generated before the rename.

@Public()
@Controller(['api/data/:workspaceId', 'w/:workspaceId'])
export class DataController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly accounts: AccountsService,
    private readonly roles: RolesService,
    private readonly sql: SqlService,
    private readonly limits: LimitsService,
    private readonly llm: LlmService,
    private readonly generate: GenerateService,
    private readonly propose: ProposeService,
  ) {}

  // No guard here on purpose: a browser never sends Authorization on a preflight.
  @Options('*path')
  preflight(@Res() res: Response) {
    res.status(204).set(DATA_CORS).end()
  }

  @UseGuards(WorkspaceGuard)
  @Get('schema')
  async schema(@Req() req: WorkspaceRequest, @Res() res: Response) {
    const p = req.workspace
    const schema = schemaFor(p.id)
    sendJson(res, { workspace: p.id, schema, ir: p.ir, ddl: irToDDL(p.ir, schema), readOnly: !!p.read_only }, 200, DATA_CORS)
  }

  @UseGuards(WorkspaceGuard)
  @Post('sql')
  async runSql(@Req() req: WorkspaceRequest, @Res() res: Response) {
    const p = req.workspace
    const body = await jsonBody<{ sql?: unknown; params?: unknown }>(req, 'body must be JSON: {"sql": "...", "params": []}')
    if (typeof body.sql !== 'string') return sendJson(res, { error: '"sql" must be a string' }, 400, DATA_CORS)
    const params = Array.isArray(body.params) ? body.params : []
    try {
      if (/^\s*(insert|update)/i.test(body.sql)) {
        const acct = await this.accounts.get(p.owner_id)
        await this.limits.assertWithinQuota(p.id, acct?.plan ?? 'free')
      }
      const role = await this.roles.ensureWorkspaceRole(p.id)
      sendJson(res, await this.sql.run(role, schemaFor(p.id), body.sql, params), 200, DATA_CORS)
    } catch (err) {
      if (err instanceof DomainError) return sendJson(res, { error: err.message }, err.status, DATA_CORS)
      throw err
    }
  }

  /**
   * Schema evolution for agents. Body: `{"ir": <full next IR>}` or `{"message": "<natural language>"}`.
   * Destructive changes are never applied here; they wait for the owner's confirmation in the builder.
   */
  @UseGuards(WorkspaceGuard)
  @Post('schema')
  async proposeSchema(@Req() req: WorkspaceRequest, @Res() res: Response) {
    const p = req.workspace
    const body = await jsonBody<{ ir?: unknown; message?: unknown }>(req, 'body must be JSON: {"ir": {...}} or {"message": "..."}')
    try {
      let next
      if (body.ir !== undefined) {
        next = this.propose.parse(body.ir)
        await this.projects.log(p.id, 'user', { message: '[api] submitted a new IR' })
      } else if (typeof body.message === 'string' && body.message.trim()) {
        const cfg = await this.llm.configFor(p.owner_id)
        if (!cfg) return sendJson(res, { error: 'workspace owner has no LLM configured; send {"ir": ...} instead' }, 409, DATA_CORS)
        await this.projects.log(p.id, 'user', { message: '[api] ' + body.message })
        next = await this.generate.toIR(cfg, p.ir, body.message)
      } else {
        return sendJson(res, { error: 'send {"ir": {...}} or {"message": "..."}' }, 400, DATA_CORS)
      }
      const r = await this.propose.propose(p, next)
      sendJson(res, {
        ...r,
        ir: r.applied ? next : p.ir,
        hint: r.needsConfirmation ? 'Destructive changes need the workspace owner to confirm them in Lovbase' : undefined,
      }, 200, DATA_CORS)
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 400, DATA_CORS)
    }
  }
}
