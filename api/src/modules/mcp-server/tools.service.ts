import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InjectPool } from '../../database/pool.provider'
import { DomainError, NotFound, TooManyRequests, Unauthorized } from '../../common/errors'
import { AccessService, type UserCtx, type AppCtx } from '../auth/access.service'
import { AccountsService } from '../accounts/accounts.service'
import { ProjectsService, schemaFor } from '../projects/projects.service'
import { ConversationService } from '../projects/conversation.service'
import { AppsService } from '../apps/apps.service'
import { AppOperationsService } from '../development/app-operations.service'
import { SqlService } from '../sql/sql.service'
import { RolesService } from '../roles/roles.service'
import { LimitsService } from '../limits/limits.service'
import { ProposeService } from '../modeling/propose.service'
import { CreditsService } from '../credits/credits.service'
import { LlmService } from '../llm/llm.service'
import { JobRepository } from '../jobs/job.repository'
import { JobQueueService } from '../jobs/job-queue.service'
import { ConfigService } from '../../config/config.service'
import { digest } from './oauth.service'
import type { UIMessage } from 'ai'

const id = z.string().min(1).max(128)
const projectInput = { projectId: id }
const appInput = { ...projectInput, appId: id }
const taskInput = { ...appInput, requestId: id.describe('Unique idempotency key; reuse only for an identical request.') }
const record = z.record(z.string(),z.unknown())
const projectOutput = z.object({ id: z.string(), name: z.string(), readOnly: z.boolean(), url: z.string() })
const appOutput = z.object({ id: z.string(), name: z.string(), sourceVersion: z.number(), publishedAt: z.string().nullable() })

@Injectable()
export class McpToolsService {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly access: AccessService,
    private readonly accounts: AccountsService, private readonly projects: ProjectsService,
    private readonly apps: AppsService, private readonly operations: AppOperationsService,
    private readonly sql: SqlService, private readonly roles: RolesService, private readonly limits: LimitsService,
    private readonly propose: ProposeService, private readonly credits: CreditsService, private readonly llm: LlmService,
    private readonly jobs: JobRepository, private readonly queues: JobQueueService,
    private readonly conversation: ConversationService, private readonly cfg: ConfigService) {}

  private url(projectId: string) { return new URL(`/projects/${projectId}`,this.cfg.env.BETTER_AUTH_URL).href }
  private projectData(p: { id: string; name: string; read_only: boolean }) { return { id: p.id, name: p.name, readOnly: !!p.read_only, url: this.url(p.id) } }
  private appData(a: { id: string; name: string; source_version: number; published_at: string | null }) {
    return { id: a.id, name: a.name, sourceVersion: Number(a.source_version), publishedAt: a.published_at ? new Date(a.published_at).toISOString() : null }
  }
  private async app(ctx: UserCtx, args: { projectId: string; appId: string }): Promise<AppCtx> {
    const p = await this.access.projectForUser(ctx,args.projectId)
    return { ...p, app: await this.apps.get(p.project.id,args.appId) }
  }
  async server(userId: string, clientId: string) {
    const user = await this.accounts.identity(userId)
    if (!user) throw new Unauthorized()
    const ctx: UserCtx = { user }
    const server = new McpServer({ name: 'lovbase', version: '1.0.0' }, {
      instructions: 'Use list_projects and get_schema to discover IDs. You act as the signed-in owner. Read files before editing and pass their version. Async tools return taskId: poll get_task. Reuse requestId only for an identical retry. Destructive schema changes require confirmation in Lovbase; project/app deletion and unpublishing are available only in the web app. Agent calls consume the owner’s credits and use their saved conversation.',
    })
    const add = (name: string, description: string, inputSchema: z.ZodRawShape, outputSchema: z.ZodRawShape, readOnly: boolean,
      run: (args: any) => Promise<Record<string, unknown>>) => {
      server.registerTool(name, { description, inputSchema, outputSchema,
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: ['start_agent_run','publish_app'].includes(name) } }, async args => {
        let ok = false
        const target = { projectId: undefined as unknown, appId: undefined as unknown, taskId: undefined as unknown, ...args }
        try {
          if (!this.limits.allowRequest(`mcp:${userId}`)) throw new TooManyRequests('Too many MCP calls; retry later')
          const data = z.object(outputSchema).parse(await run(args))
          const createdProject = data.project as { id?: string } | undefined
          const createdApp = data.app as { id?: string } | undefined
          target.projectId ??= createdProject?.id
          target.appId ??= createdApp?.id
          target.taskId ??= data.taskId
          const text = JSON.stringify(data)
          if (Buffer.byteLength(text) > 1_000_000) throw new DomainError('Result is too large; request fewer rows or smaller fields')
          ok = true
          return { content: [{ type: 'text' as const, text }], structuredContent: data }
        } catch (e) {
          const message = e instanceof DomainError ? e.message : 'Operation failed. Inspect the project in Lovbase before retrying.'
          return { isError: true, content: [{ type: 'text' as const, text: message }],
            _meta: { error: { code: e instanceof DomainError ? e.name : 'InternalError', status: e instanceof DomainError ? e.status : 500 } } }
        } finally {
          await this.pool.query(`INSERT INTO public.lb_mcp_server_audit(user_id,client_id,tool,project_id,app_id,task_id,ok) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [userId,clientId,name,target.projectId ?? null,target.appId ?? null,target.taskId ?? null,ok]).catch(() => {})
        }
      })
    }
    add('list_projects','List projects owned by you. No internal credentials are returned.',{}, { projects: z.array(projectOutput) },true,
      async () => ({ projects: (await this.projects.listFor(userId)).map(p => this.projectData(p)) }))
    add('get_project','Read project details and applications.',projectInput,{ project: projectOutput, apps: z.array(appOutput) },true,async a => {
      const { project } = await this.access.projectForUser(ctx,a.projectId)
      return { project: this.projectData(project), apps: (await this.apps.list(project.id)).map(app => this.appData(app)) }
    })
    add('create_project','Create an empty project and its first application within your plan quota.',{}, { project: projectOutput, apps: z.array(appOutput) },false,async () => {
      const project = await this.projects.createFor(ctx)
      return { project: this.projectData(project), apps: (await this.apps.list(project.id)).map(app => this.appData(app)) }
    })
    add('get_schema','Read the project IR and database tables. Use stable IR IDs when proposing changes.',projectInput,{ ir: record, schema: z.string(), tables: z.array(record) },true,async a => {
      const { project } = await this.access.projectForUser(ctx,a.projectId)
      return { ir: project.ir, schema: schemaFor(project.id), tables: await this.sql.introspect(schemaFor(project.id)) }
    })
    for (const readOnly of [true,false]) add(readOnly ? 'query_database' : 'execute_database',readOnly ? 'Execute one SQL query in a read-only transaction.' : 'Execute one parameterized data statement. Cannot change table structure.',
      { ...projectInput, sql: z.string().min(1).max(100_000), params: z.array(z.unknown()).max(1000).default([]) },
      { rows: z.array(record), rowCount: z.number(), fields: z.array(z.string()), truncated: z.boolean(), kind: z.enum(['read','write']) },readOnly,async a => {
        const { project } = await this.access.projectForUser(ctx,a.projectId)
        const role = await this.roles.ensureWorkspaceRole(project.id)
        const result = await this.sql.run(role,schemaFor(project.id),a.sql,a.params,readOnly)
        // A successful write must not look like a failed tool call merely because RETURNING is large.
        let bytes = 0
        const rows = []
        for (const row of result.rows) {
          bytes += Buffer.byteLength(JSON.stringify(row))
          if (bytes > 512_000) break
          rows.push(row)
        }
        return { ...result, rows, truncated: result.truncated || rows.length < result.rows.length }
      })
    add('propose_schema','Submit a complete next IR. Destructive changes wait for owner confirmation in the web app.',
      { ...projectInput, ir: record },{ applied: z.boolean(), needsConfirmation: z.boolean().optional(), pendingId: z.string().optional(), changes: z.array(record), url: z.string() },false,async a => {
        const { project } = await this.access.projectForUser(ctx,a.projectId)
        return { ...await this.propose.propose(project,this.propose.parse(a.ir)), url: this.url(project.id) }
      })
    add('list_apps','List applications in a project.',projectInput,{ apps: z.array(appOutput) },true,async a => {
      await this.access.projectForUser(ctx,a.projectId)
      return { apps: (await this.apps.list(a.projectId)).map(app => this.appData(app)) }
    })
    add('create_app','Create an application in a project.',{ ...projectInput, name: z.string().trim().min(1).max(40) },{ app: appOutput },false,async a => {
      await this.access.projectForUser(ctx,a.projectId)
      return { app: this.appData(await this.apps.create(a.projectId,a.name)) }
    })
    add('rename_app','Rename an application.',{ ...appInput, name: z.string().trim().min(1).max(40) },{ ok: z.boolean() },false,async a => {
      await this.app(ctx,a); await this.apps.rename(a.projectId,a.appId,a.name); return { ok: true }
    })
    add('list_files','List editable application source files and the current version.',appInput,{ files: z.array(z.object({ path: z.string(), size: z.number() })), version: z.number() },true,
      async a => this.operations.files(await this.app(ctx,a)))
    add('read_file','Read an application source file and its version.',{ ...appInput, path: z.string().min(1).max(500) },{ path: z.string(), content: z.string(), version: z.number() },true,
      async a => this.operations.read(await this.app(ctx,a),a.path))
    add('write_file','Create or replace an application source file. Pass the version from read_file/list_files; conflicts require a fresh read.',
      { ...appInput, path: z.string().min(1).max(500), content: z.string().max(512_000), expectedVersion: z.number().int().nonnegative() },{ version: z.number() },false,
      async a => this.operations.write(await this.app(ctx,a),a.path,a.content,a.expectedVersion))
    const taskOutput = { taskId: z.string(), status: z.string(), url: z.string() }
    add('start_agent_run','Start a Lovbase Agent turn using the existing conversation and credits. Returns a durable task.',
      { ...taskInput, prompt: z.string().trim().min(1).max(50_000) },taskOutput,false,async a => this.submit(await this.app(ctx,a),'agent',a.requestId,a.prompt))
    for (const operation of ['preview','build','publish'] as const) add(`${operation}_app`,`${operation} the application. Returns a durable task; poll get_task for results. No model is invoked.`,
      taskInput,taskOutput,false,async a => this.submit(await this.app(ctx,a),operation,a.requestId))
    add('get_task','Read a task status, result and pending web confirmations.',{ taskId: id },
      { taskId: z.string(), status: z.string(), result: record.nullable(), progress: record.nullable(), pendingIds: z.array(z.string()), error: z.string().nullable(), url: z.string() },true,async a => {
        const job = await this.ownedTask(ctx,a.taskId)
        const active = !['succeeded','failed','cancelled','interrupted'].includes(job.status)
        const live = active ? await this.conversation.liveRun(job.project_id) : null
        const chat = job.input.operation || job.result || !active ? null : await this.conversation.getChat(job.project_id)
        let result = job.result ?? (chat ? { messages: chat } : null)
        if (result && Buffer.byteLength(JSON.stringify(result)) > 512_000) {
          // Keep status usable even when a model produced a very large transcript.
          const messages = Array.isArray(result.messages) ? result.messages.slice(-10) : []
          while (messages.length && Buffer.byteLength(JSON.stringify(messages)) > 500_000) messages.shift()
          result = { messages, truncated: true, hint: 'Open the project for the full result' }
        }
        const pending = await this.pool.query('SELECT id FROM public.lb_pending WHERE project_id=$1', [job.project_id])
        return { taskId: job.id, status: job.status, result, progress: live?.progress ?? (active ? { phase: job.status, operation: job.input.operation ?? 'agent' } : null),
          pendingIds: pending.rows.map(row => String(row.id)), error: job.error, url: this.url(job.project_id) }
      })
    add('cancel_task','Cancel a queued task or a running Agent turn. Application operations cannot be cancelled after execution starts.',{ taskId: id },{ ok: z.boolean() },false,async a => {
      const job = await this.ownedTask(ctx,a.taskId)
      const cancelled = await this.jobs.requestCancel(job.project_id,job.id)
      if (cancelled) await this.queues.cancel(cancelled.id)
      return { ok: true }
    })
    return server
  }
  private async ownedTask(ctx: UserCtx, taskId: string) {
    const job = await this.jobs.get(taskId)
    if (!job || job.user_id !== ctx.user.id) throw new NotFound('Task not found')
    await this.access.projectForUser(ctx,job.project_id)
    return job
  }
  private async submit(ctx: AppCtx, operation: 'agent' | 'preview' | 'build' | 'publish', requestId: string, prompt?: string) {
    const key = `mcp:${ctx.user.id}:${operation}:${requestId}`
    const fingerprint = digest(JSON.stringify({ projectId: ctx.project.id, appId: ctx.app.id, operation, prompt }))
    const existing = await this.jobs.byRequest(key)
    if (existing) {
      if (existing.user_id !== ctx.user.id || existing.input.fingerprint !== fingerprint) throw new DomainError('requestId was already used with different parameters')
      return { taskId: existing.id, status: existing.status, url: this.url(ctx.project.id) }
    }
    let messages: UIMessage[] = []
    if (operation === 'agent') {
      if (!await this.llm.configFor(ctx.user.id)) throw new DomainError('No model configured; configure a model in Lovbase')
      await this.credits.assert(ctx.user.id,'message')
      messages = [...await this.conversation.getChat(ctx.project.id) as UIMessage[], { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: prompt! }] }]
    }
    const { job, created } = await this.jobs.createTurn({ requestId: key,projectId: ctx.project.id,appId: ctx.app.id,userId: ctx.user.id,
      turn: { appId: ctx.app.id,messages,fingerprint,...(operation !== 'agent' ? { operation } : {}) } })
    if (created) await this.queues.enqueue(job.id)
    return { taskId: job.id, status: job.status, url: this.url(ctx.project.id) }
  }
}
