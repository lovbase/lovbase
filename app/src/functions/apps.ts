import { createServerFn } from '@tanstack/react-start'
import { planOf } from '@lovbase/core/plans'
import {
  AppOperationsService, AppsService, ConfigService, GenerationService, ProjectsService, RESERVED_SUBDOMAINS,
  SandboxLeaseService, SandboxService, looksLikePreviewHost, svc,
} from '@lovbase/api'
import { requireApp, requireProject } from './_ctx'

// ── App builder (sandbox + pi) ──

async function withSandboxLease<T>(appId: string, run: (sandbox: SandboxService) => Promise<T>): Promise<T> {
  return (await svc(AppOperationsService)).withLease(appId, run)
}

export const agentRun = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string; prompt: string }) => {
    if (!d.prompt?.trim()) throw new Error('empty prompt')
    return d
  })
  .handler(async ({ data }) => {
    const { user, project: p0, app } = await requireApp(data.projectId, data.appId)
    const projects = await svc(ProjectsService)
    const project = await projects.ensureApiToken(p0)
    await projects.log(project.id, 'user', { message: '[app] ' + data.prompt })
    const r = await withSandboxLease(app.id, () => (async () => {
      const generation=await svc(GenerationService)
      return generation.run(user.id,project.id,app.id,data.prompt.replace(/@\[([^\]]+)\]/g, 'file `$1`'))
    })())
    await projects.log(project.id, 'agent', {
      note: r.ok ? '[app] agent finished a turn' : '[app] agent failed',
      changes: [], output: r.output.slice(-2000), previewUrl: r.previewUrl,
    })
    return r
  })

export const agentPreview = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await requireApp(data.projectId, data.appId)
    const operations = await svc(AppOperationsService)
    return operations.withLease(ctx.app.id, () => operations.perform(ctx, 'preview'))
  })

/** Lightweight runtime state for switching a live iframe to the finalized static snapshot. */
export const appRuntime = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const { app } = await requireApp(data.projectId, data.appId)
    return {
      state: app.runtime_state,
      sourceVersion: Number(app.source_version),
      snapshotVersion: Number(app.snapshot_version),
      snapUrl: app.snap_at ? `/api/snap/${app.id}/?v=${Date.parse(app.snap_at)}` : null,
    }
  })

export const agentBuild = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await requireApp(data.projectId, data.appId)
    const operations = await svc(AppOperationsService)
    return operations.withLease(ctx.app.id, () => operations.perform(ctx, 'build'))
  })

/** Return the durable task immediately; compilation and upload run in the worker. */
export const publishApp = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string; requestId: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await requireApp(data.projectId, data.appId)
    return (await svc(AppOperationsService)).submitPublish(ctx, data.requestId)
  })

export const publishStatus = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string; taskId?: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await requireApp(data.projectId, data.appId)
    return (await svc(AppOperationsService)).publishStatus(ctx, data.taskId)
  })

/** Take a published app offline: delete what object storage is serving and forget the subdomain. */
export const unpublishApp = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const { app } = await requireApp(data.projectId, data.appId)
    if (!app.slug) return { ok: true as const }
    await withSandboxLease(app.id, async sandbox => {
      await sandbox.unpublish(app.id, app.slug!)
      await (await svc(AppsService)).clearPublish(app.id)
    })
    return { ok: true as const }
  })

/** Choosing the subdomain is a paid feature; free apps publish under their id. */
export const renameSubdomain = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string; slug: string }) => d)
  .handler(async ({ data }) => {
    const { user, app } = await requireApp(data.projectId, data.appId)
    if (!planOf(user.plan).customSubdomain) throw new Error('LIMIT:A custom subdomain is a feature of the Pro plan and above')
    const slug = data.slug.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) throw new Error('Only lowercase letters, digits and hyphens, 2 to 41 characters')
    if (RESERVED_SUBDOMAINS.has(slug) || looksLikePreviewHost(slug)) throw new Error('This subdomain is reserved; pick another')
    // SlugTaken is already a DomainError with the message the UI shows; wrapping it only lost the stack.
    await withSandboxLease(app.id, async () => { await (await svc(AppsService)).setSlug(app.id, slug) })
    return { ok: true as const, slug, url: (await svc(ConfigService)).appUrl(slug) }
  })

// ── Apps of a workspace ──

export const appCreate = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; name: string }) => ({ projectId: d.projectId, name: (d.name || 'New app').trim().slice(0, 40) }))
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    const a = await (await svc(AppsService)).create(project.id, data.name)
    return { id: a.id, name: a.name }
  })

export const appRename = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string; name: string }) => d)
  .handler(async ({ data }) => {
    const { project, app } = await requireApp(data.projectId, data.appId)
    await (await svc(AppsService)).rename(project.id, app.id, data.name.trim().slice(0, 40))
    return { ok: true }
  })

export const appDelete = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const { project, app } = await requireApp(data.projectId, data.appId)
    const apps = await svc(AppsService)
    if ((await apps.list(project.id)).length <= 1) throw new Error('Keep at least one app')
    await (await svc(SandboxService)).reclaim(app.id, app.slug)
    await (await svc(SandboxLeaseService)).removeApp(app.id)
    await apps.remove(project.id, app.id)
    return { ok: true }
  })

// ── App source files ──

export const appFiles = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => (await svc(AppOperationsService)).files(await requireApp(data.projectId, data.appId)))

export const appReadFile = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string; path: string }) => d)
  .handler(async ({ data }) => (await svc(AppOperationsService)).read(await requireApp(data.projectId, data.appId), data.path))

export const appWriteFile = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string; path: string; content: string; expectedVersion?: number }) => d)
  .handler(async ({ data }) => (await svc(AppOperationsService)).write(await requireApp(data.projectId, data.appId), data.path, data.content, data.expectedVersion))
