import { LimitsService } from '../limits/limits.service'
import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import type { UIMessage } from 'ai'
import { diffIR, irEquals } from '@lovbase/core/diff'
import { qi } from '@lovbase/core/ddl'
import { SHEETS_MAX_BYTES, SheetMapping, SheetSource, type SheetSnapshot, type SheetPreview } from '@lovbase/core/sheets'
import type { IR } from '@lovbase/core/ir'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { ConfigService } from '../../config/config.service'
import { DomainError, NotFound } from '../../common/errors'
import { randomId } from '../../common/ids'
import type { AppCtx, ProjectCtx } from '../auth/access.service'
import { schemaFor } from '../projects/projects.service'
import { ApplyService } from '../modeling/apply.service'
import { ProposeService } from '../modeling/propose.service'
import { JobRepository } from '../jobs/job.repository'
import { JobQueueService } from '../jobs/job-queue.service'
import { LlmService } from '../llm/llm.service'
import { CreditsService } from '../credits/credits.service'
import { ConversationService } from '../projects/conversation.service'
import { ConnectionsService } from './connections.service'
import { ComposioService } from './composio.service'
import { convertSnapshot, defaultMapping } from './sheets'

type ImportRow = {
  id: string; project_id: string; app_id: string; user_id: string; connection_id: string | null
  source: SheetSource; snapshot: SheetSnapshot; mapping: SheetMapping; base_ir: IR
  version: number; status: SheetPreview['status']; entity_id: string | null; job_id: string | null
}
@Injectable()
export class SheetImportsService {
  constructor(
    @InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService,
    private readonly cfg: ConfigService, private readonly connections: ConnectionsService, private readonly composio: ComposioService,
    private readonly propose: ProposeService, private readonly apply: ApplyService,
    private readonly jobs: JobRepository, private readonly queue: JobQueueService, private readonly llm: LlmService,
    private readonly credits: CreditsService, private readonly conversation: ConversationService, private readonly limits: LimitsService,
  ) {}
  get enabled() { return this.connections.enabled }
  async info(userId: string, projectId: string, url: string, connectionId?: string) {
    const c = await this.connections.active(userId, projectId, this.pool, connectionId)
    return { ...await this.composio.info(userId, c.account_id, c.auth_config_id, url), connection: { id: c.id, label: c.identity || c.label || c.app_name } }
  }
  private async row(userId: string, projectId: string, id: string, db: Pick<pg.PoolClient, 'query'> = this.pool, lock = false): Promise<ImportRow> {
    await this.schema.ready()
    const r = await db.query(`SELECT * FROM public.lb_sheet_imports WHERE id = $1 AND project_id = $2 AND user_id = $3${lock ? ' FOR UPDATE' : ''}`, [id, projectId, userId])
    if (!r.rows[0]) throw new NotFound('Import not found.')
    return r.rows[0]
  }
  private async view(row: ImportRow): Promise<SheetPreview> {
    const job = row.job_id ? await this.jobs.get(row.job_id) : null
    const connection = row.connection_id ? await this.pool.query('SELECT id, identity, label, app_name FROM public.lb_connections WHERE id = $1 AND user_id = $2', [row.connection_id, row.user_id]) : null
    const c = connection?.rows[0]
    return { ...(c ? { connection: { id: c.id, label: c.identity || c.label || c.app_name } } : {}), id: row.id, version: row.version, appId: row.app_id, source: row.source, mapping: row.mapping,
      headers: row.snapshot.headers, sample: row.snapshot.rows.slice(0, 5).map(r => r.map(v => typeof v === 'string' && v.length > 240 ? v.slice(0, 240) + '…' : v)), rowCount: row.snapshot.rows.length,
      errors: convertSnapshot(row.snapshot, row.mapping).errors, status: row.status, entityId: row.entity_id,
      job: job ? { status: job.status, error: job.error } : null }
  }
  async list(ctx: ProjectCtx) {
    if (!this.enabled) return []
    await this.schema.ready()
    const r = await this.pool.query('SELECT * FROM public.lb_sheet_imports WHERE project_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 10', [ctx.project.id, ctx.user.id])
    return Promise.all((r.rows as ImportRow[]).map(row => this.view(row)))
  }
  async get(ctx: ProjectCtx, id: string) { return this.view(await this.row(ctx.user.id, ctx.project.id, id)) }
  private async quota(client: pg.PoolClient, projectId: string, userId: string, extra = 0) {
    await this.limits.lock(client,userId)
    await this.limits.assertAccount(userId,client,extra)
  }
  async prepare(userId: string, projectId: string, appId: string, input: SheetSource) {
    const source = SheetSource.parse(input)
    const c = await this.connections.active(userId, projectId, this.pool, source.connectionId)
    source.connectionId = c.id
    const app = await this.pool.query('SELECT 1 FROM public.lb_apps WHERE id = $1 AND project_id = $2', [appId, projectId])
    if (!app.rowCount) throw new NotFound('App not found.')
    const { snapshot, title } = await this.composio.read(userId, c.account_id, c.auth_config_id, source)
    if (Buffer.byteLength(JSON.stringify(snapshot)) > SHEETS_MAX_BYTES) throw new DomainError('The snapshot exceeds 10 MiB. Select a smaller range.')
    const client = await this.pool.connect(), id = 'si_' + randomId(20)
    try {
      await client.query('BEGIN')
      await this.limits.lock(client,userId)
      const p = await client.query('SELECT ir, read_only FROM public.lb_projects WHERE id = $1 AND owner_id = $2 FOR UPDATE', [projectId, userId])
      if (!p.rows[0] || p.rows[0].read_only) throw new DomainError('This project cannot be changed.')
      // Hold the account and project binding through commit, including when access changed during the read.
      await this.connections.active(userId, projectId, client, c.id)
      await this.quota(client, projectId, userId, Buffer.byteLength(JSON.stringify(snapshot)))
      await client.query(`INSERT INTO public.lb_sheet_imports(id, project_id, app_id, user_id, connection_id, source, snapshot, mapping, base_ir)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, projectId, appId, userId, c.id, JSON.stringify(source), JSON.stringify(snapshot), JSON.stringify(defaultMapping(snapshot, title)), JSON.stringify(p.rows[0].ir)])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    return this.view(await this.row(userId, projectId, id))
  }
  async update(ctx: ProjectCtx, id: string, version: number, input: SheetMapping) {
    const mapping = SheetMapping.parse(input)
    const row = await this.row(ctx.user.id, ctx.project.id, id)
    if (row.status !== 'preview' || row.version !== version) throw new DomainError('This preview changed or was already confirmed. Refresh it.')
    const r = await this.pool.query(`UPDATE public.lb_sheet_imports SET mapping = $4, version = version + 1
      WHERE id = $1 AND user_id = $2 AND version = $3 AND status = 'preview' RETURNING *`, [id, ctx.user.id, version, JSON.stringify(mapping)])
    if (!r.rows[0]) throw new DomainError('This preview changed. Refresh it.')
    return this.view(r.rows[0])
  }
  async confirm(ctx: AppCtx, id: string, version: number) {
    const row = await this.row(ctx.user.id, ctx.project.id, id)
    if (row.app_id !== ctx.app.id || row.version !== version) throw new DomainError('The app or preview version changed. Refresh it.')
    const previous = row.job_id ? await this.jobs.get(row.job_id) : null
    if (previous && !['failed', 'cancelled', 'interrupted'].includes(previous.status)) return { jobId: previous.id }
    if (convertSnapshot(row.snapshot, row.mapping).errors.length) throw new DomainError('Correct the conversion errors before confirming.')
    if (!await this.llm.configFor(ctx.user.id)) throw new DomainError('Configure a model before building the app.')
    await this.credits.assert(ctx.user.id, 'message')
    const messages = await this.conversation.getChat(ctx.project.id) as UIMessage[]
    const message: UIMessage = { id: 'msg_' + randomId(18), role: 'user', parts: [{ type: 'text', text: `Build an interface for the confirmed Google Sheets import “${row.mapping.tableName}”. The worker imports the data before you start. Use the existing imported table; do not re-import or recreate it. Follow the requirements already discussed.` }] }
    const requestId = `sheets:${id}:${version}:${previous?.id ?? 'initial'}`
    const { job } = await this.jobs.createTurn({
      requestId, projectId: ctx.project.id, appId: ctx.app.id, userId: ctx.user.id,
      turn: { appId: ctx.app.id, messages: [...messages, message], importId: id },
    }, async (client, jobId) => {
      const locked = await this.row(ctx.user.id, ctx.project.id, id, client, true)
      if (locked.version !== version || locked.job_id !== row.job_id) throw new DomainError('This import changed. Refresh it.')
      if (locked.status !== 'imported') {
        const p = await client.query('SELECT ir, read_only FROM public.lb_projects WHERE id = $1 FOR UPDATE', [ctx.project.id])
        if (p.rows[0]?.read_only || !irEquals(p.rows[0]?.ir, locked.base_ir)) throw new DomainError('The data model changed. Prepare a new preview.')
        const active = await this.connections.active(ctx.user.id, ctx.project.id, client, locked.connection_id ?? 'disconnected')
        if (active.id !== locked.connection_id) throw new DomainError('The source connection changed. Prepare a new preview.')
      }
      await client.query(`UPDATE public.lb_sheet_imports SET status = CASE WHEN status = 'imported' THEN status ELSE 'queued' END, job_id = $2 WHERE id = $1`, [id, jobId])
    }).catch(async error => {
      // Two tabs may confirm the same preview concurrently. The winning transaction owns
      // the stable request ID; attach the second reader after its transaction rolled back.
      const existing = await this.jobs.byRequest(requestId)
      if (existing && existing.user_id === ctx.user.id && existing.project_id === ctx.project.id) return { job: existing, created: false }
      throw error
    })
    await this.queue.enqueue(job.id)
    return { jobId: job.id }
  }
  /** Worker-only: the queue contains an authenticated confirmation, never a model-supplied approval. */
  async execute(userId: string, projectId: string, appId: string, id: string, jobId: string) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.limits.lock(client,userId)
      await client.query("SET LOCAL statement_timeout = '30s'")
      await client.query("SET LOCAL lock_timeout = '10s'")
      const row = await this.row(userId, projectId, id, client, true)
      if (row.app_id !== appId || row.job_id !== jobId || !['queued', 'imported'].includes(row.status)) throw new DomainError('This import was not confirmed for this task.')
      if (row.status === 'imported') { await client.query('COMMIT'); return }
      const p = await client.query('SELECT * FROM public.lb_projects WHERE id = $1 AND owner_id = $2 FOR UPDATE', [projectId, userId])
      if (!p.rows[0] || p.rows[0].read_only || !irEquals(p.rows[0].ir, row.base_ir)) throw new DomainError('The data model changed. Prepare a new preview.')
      const cancelled = await client.query('SELECT cancel_requested_at FROM public.lb_jobs WHERE id = $1', [jobId])
      if (cancelled.rows[0]?.cancel_requested_at) throw new DomainError('Import cancelled.')
      const active = await this.connections.active(userId, projectId, client, row.connection_id ?? 'disconnected')
      if (active.id !== row.connection_id) throw new DomainError('The source connection was changed or disabled.')
      const { rows, errors } = convertSnapshot(row.snapshot, SheetMapping.parse(row.mapping))
      if (errors.length) throw new DomainError(errors.join('\n'))
      const entityId = 'e_' + randomId(20)
      const next = this.propose.parse({ ...p.rows[0].ir, entities: [...p.rows[0].ir.entities, {
        id: entityId, name: row.mapping.tableName, dbName: `sheet_${randomId(16).toLowerCase()}`,
        fields: row.mapping.fields.map((f, i) => ({ id: 'f_' + randomId(20), name: f.name, dbName: `col_${i + 1}`, type: f.type, required: false })),
      }] })
      const changes = diffIR(p.rows[0].ir, next)
      if (changes.some(c => c.kind !== 'create_entity')) throw new DomainError('An import may only add a new table.')
      await this.apply.applyInTransaction(client, projectId, next, changes)
      const entity = next.entities[next.entities.length - 1]
      const ref = `${qi(schemaFor(projectId))}.${qi(entity.dbName)}`
      const columns = entity.fields.map(f => qi(f.dbName)).join(',')
      const batchSize = Math.max(1, Math.floor(30_000 / entity.fields.length))
      for (let start = 0; start < rows.length; start += batchSize) {
        const batch = rows.slice(start, start + batchSize)
        const tuples = batch.map((values, i) => `(${values.map((_, j) => `$${i * entity.fields.length + j + 1}`).join(',')})`).join(',')
        await client.query(`INSERT INTO ${ref} (${columns}) VALUES ${tuples}`, batch.flat())
      }
      await this.quota(client, projectId, userId)
      const cancel = await client.query('SELECT cancel_requested_at FROM public.lb_jobs WHERE id = $1', [jobId])
      if (cancel.rows[0]?.cancel_requested_at) throw new DomainError('Import cancelled.')
      await client.query("UPDATE public.lb_sheet_imports SET status = 'imported', entity_id = $2, imported_at = now() WHERE id = $1", [id, entityId])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
}
