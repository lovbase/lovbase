import { LimitsService } from '../limits/limits.service'
import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { ConfigService } from '../../config/config.service'
import { DomainError } from '../../common/errors'
import type { AppCtx } from '../auth/access.service'
import { AppsService } from '../apps/apps.service'
import { ProjectsService } from '../projects/projects.service'
import { JobQueueService } from '../jobs/job-queue.service'
import { JobRepository, ActiveProjectJob } from '../jobs/job.repository'
import { SandboxService } from '../sandbox/sandbox.service'
import { SandboxLeaseService } from '../sandbox/sandbox-lease.service'
import { CoversService } from '../storage/covers.service'
import { isSourcePath, sourcePath } from './files'
import { publishState } from '../jobs/publish-state'

@Injectable()
export class AppOperationsService {
  constructor(private readonly cfg: ConfigService, private readonly apps: AppsService,
    private readonly projects: ProjectsService, private readonly sandbox: SandboxService,
    private readonly leases: SandboxLeaseService, private readonly queues: JobQueueService,
    private readonly jobs: JobRepository, private readonly covers: CoversService, private readonly limits: LimitsService) {}

  /** Persist first; the queue reconciler also recovers submissions during a Redis outage. */
  async submitPublish(ctx: AppCtx, requestId: string) {
    if (!/^[\w-]{8,100}$/.test(requestId)) throw new DomainError('Invalid publish request ID')
    const input = { requestId: `web:publish:${ctx.user.id}:${requestId}`, projectId: ctx.project.id,
      appId: ctx.app.id, userId: ctx.user.id,
      turn: { appId: ctx.app.id, operation: 'publish' as const, messages: [] } }
    const existing = await this.jobs.byRequest(input.requestId)
    if (!existing) {
      const active = await this.jobs.activeForProject(ctx.project.id)
      if (active?.app_id === ctx.app.id && active.input.operation === 'publish') return publishState(active)
      if (active) throw new ActiveProjectJob()
    }
    try {
      const { job, created } = await this.jobs.createTurn(input)
      if (created) await this.queues.enqueue(job.id)
      return publishState(job)
    } catch (error) {
      if (error instanceof ActiveProjectJob) {
        const active = await this.jobs.activeForProject(ctx.project.id)
        if (active?.app_id === ctx.app.id && active.input.operation === 'publish') return publishState(active)
      }
      throw error
    }
  }

  async withLease<T>(appId: string, fn: (sandbox: SandboxService) => Promise<T>): Promise<T> {
    const app = await this.apps.findById(appId)
    if (!app) throw new DomainError('App not found')
    if (await this.jobs.activeForProject(app.project_id)) throw new ActiveProjectJob()
    const lease = await this.leases.acquire(appId, `interactive-${randomUUID()}`, Date.now(), (await this.limits.plan(await this.limits.owner(app.project_id))).priority ? 1 : 2)
    if (!lease) throw new DomainError('App or build slots are busy; try again in a moment')
    let lost = false
    const renewal = setInterval(() => { void this.leases.renew(lease).then(ok => { if (!ok) lost = true }).catch(() => { lost = true }) }, this.cfg.env.SANDBOX_LEASE_RENEW_SECONDS * 1000)
    renewal.unref?.()
    try {
      await this.sandbox.claimLease(appId, lease.generation)
      await this.queues.cancelRelease(appId, lease.generation)
      await this.apps.markRuntime(appId, 'live')
      const result = await fn(this.sandbox)
      if (lost) throw new DomainError('Sandbox lease was lost; reload before retrying')
      return result
    } finally {
      clearInterval(renewal)
      const warmUntil = Date.now() + this.cfg.env.CONTAINER_WARM_GRACE_SECONDS * 1000
      if (!lost && await this.leases.markWarm(lease, warmUntil)) {
        const { sourceVersion } = await this.apps.versions(appId)
        await this.queues.scheduleRelease({ appId, generation: lease.generation, expectedSourceVersion: sourceVersion }, warmUntil)
      }
    }
  }
  async files(ctx: AppCtx) {
    const { files, version } = await this.apps.versionedSnapshot(ctx.app.id)
    if (files?.length) return { files: files.filter(f => isSourcePath(f.path)).map(f => ({ path: f.path, size: Buffer.byteLength(f.content) })), version }
    return this.withLease(ctx.app.id, async sandbox => {
      await sandbox.restoreIfFresh(ctx.app.id, () => this.apps.loadSnapshot(ctx.app.id))
      const r = await sandbox.files(ctx.app.id)
      return { ...r, files: r.files.filter(f => isSourcePath(f.path)), version }
    })
  }
  async read(ctx: AppCtx, path: string) {
    sourcePath(path)
    // One SQL snapshot keeps content and version consistent.
    const snapshot = await this.apps.versionedSnapshot(ctx.app.id)
    const file = snapshot.files?.find(f => f.path === path)
    if (file?.encoding === 'base64') throw new DomainError('Binary files cannot be edited as text; use source export to download them')
    if (file) return { path, content: file.content, version: snapshot.version }
    return this.withLease(ctx.app.id, async sandbox => {
      await sandbox.restoreIfFresh(ctx.app.id, () => this.apps.loadSnapshot(ctx.app.id))
      return { ...await sandbox.readFile(ctx.app.id,path), version: (await this.apps.versions(ctx.app.id)).sourceVersion }
    })
  }
  async write(ctx: AppCtx, path: string, content: string, expectedVersion?: number) {
    sourcePath(path)
    if (Buffer.byteLength(content) > 512_000) throw new DomainError('File exceeds 512 KB')
    return this.withLease(ctx.app.id, async sandbox => {
      const version = (await this.apps.versions(ctx.app.id)).sourceVersion
      if (expectedVersion !== undefined && expectedVersion !== version) throw new DomainError('File version conflict; read the latest version before writing')
      await sandbox.restoreIfFresh(ctx.app.id, () => this.apps.loadSnapshot(ctx.app.id))
      // Export before changing anything: the best-effort Agent snapshot helper may swallow
      // failures, which would acknowledge a write without advancing its durable version.
      const { files } = await sandbox.exportFiles(ctx.app.id)
      if (!files.length) throw new DomainError('Cannot save an empty source snapshot; retry later')
      const r = await sandbox.writeFile(ctx.app.id,path,content)
      const next = [...files.filter(file => file.path !== path), { path, content }]
      try { await this.apps.saveSnapshot(ctx.app.id,next) }
      catch (error) {
        // Discard the uncommitted runtime edit; the next lease restores the last saved source.
        await sandbox.resetSource(ctx.app.id)
        throw error
      }
      return { ...r, version: (await this.apps.versions(ctx.app.id)).sourceVersion }
    })
  }
  /** Caller holds the exclusive lease (web helper or durable worker). */
  perform(ctx: AppCtx, operation: 'preview'): Promise<{ previewUrl: string }>
  perform(ctx: AppCtx, operation: 'build'): ReturnType<SandboxService['build']>
  perform(ctx: AppCtx, operation: 'publish'): Promise<{ ok: boolean; slug: string; files: number; url: string; error?: string }>
  perform(ctx: AppCtx, operation: 'preview' | 'build' | 'publish'): Promise<Record<string, unknown>>
  async perform(ctx: AppCtx, operation: 'preview' | 'build' | 'publish'): Promise<Awaited<ReturnType<SandboxService['preview']>> | Awaited<ReturnType<SandboxService['build']>> | { ok: boolean; slug: string; files: number; url: string; error?: string }> {
    const { app } = ctx
    await this.sandbox.restoreIfFresh(app.id, () => this.apps.loadSnapshot(app.id))
    if (operation === 'preview') {
      const project = await this.projects.ensureApiToken(ctx.project)
      return this.sandbox.preview(app.id,{ workspaceId: project.id, apiToken: project.api_token })
    }
    if (operation === 'build') {
      const r = await this.sandbox.build(app.id)
      if (!r.ok) throw new DomainError(r.stderr || 'Build failed')
      return r
    }
    await this.limits.reservePublish(ctx.user.id,app.id)
    try {
    const slug = await this.apps.claimSlug(app.id)
    const r = await this.sandbox.publish(app.id,slug)
    if (!r.ok) throw new DomainError(r.error || r.stderr || 'Publish failed')
    await this.apps.markPublished(app.id)
    const url = this.cfg.appUrl(slug)
    void this.covers.capture(ctx.project.id,app.id,url).catch(() => {})
    return { ok: true, slug, files: r.files ?? 0, url }
    } finally { await this.limits.releasePublish(app.id) }
  }
}
