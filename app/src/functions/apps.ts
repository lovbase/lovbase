import { createServerFn } from '@tanstack/react-start'
import { planOf } from '@lovbase/core/plans'
import {
  AppsService, ConfigService, CoversService, JobQueueService, LlmService, ProjectsService, RESERVED_SUBDOMAINS,
  SandboxLeaseService, SandboxService, looksLikePreviewHost, svc,
} from '@lovbase/api'
import { requireApp, requireProject } from './_ctx'

// ── App builder (sandbox + pi) ──

async function withSandboxLease<T>(appId: string, run: (sandbox: SandboxService) => Promise<T>): Promise<T> {
  const leases = await svc(SandboxLeaseService)
  const config = await svc(ConfigService)
  // Stable per app so a code-pane list and read arriving together share one lease instead of
  // rejecting each other as competing owners. Authentication still happens before this helper.
  const owner = `web-${appId}`
  const lease = await leases.acquire(appId, owner, Date.now())
  if (!lease) throw new Error('All build slots are busy; try again in a moment')
  await (await svc(SandboxService)).claimLease(appId, lease.generation)
  await (await svc(JobQueueService)).cancelRelease(appId, lease.generation)
  await (await svc(AppsService)).markRuntime(appId, 'live')
  const renewal = setInterval(() => { void leases.renew(lease) }, config.env.SANDBOX_LEASE_RENEW_SECONDS * 1000)
  renewal.unref?.()
  try {
    return await run(await svc(SandboxService))
  } finally {
    clearInterval(renewal)
    const warmUntil = Date.now() + config.env.CONTAINER_WARM_GRACE_SECONDS * 1000
    if (await leases.markWarm(lease, warmUntil)) {
      const { sourceVersion } = await (await svc(AppsService)).versions(appId)
      await (await svc(JobQueueService)).scheduleRelease({ appId, generation: lease.generation, expectedSourceVersion: sourceVersion }, warmUntil)
    }
  }
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
    const cfg = await (await svc(LlmService)).configFor(user.id)
    if (!cfg) throw new Error('The platform has no model configured yet; contact an administrator')
    await projects.log(project.id, 'user', { message: '[app] ' + data.prompt })
    const r = await withSandboxLease(app.id, (sandbox) => sandbox.run(app.id, {
        workspaceId: project.id,
        apiToken: project.api_token,
        prompt: data.prompt.replace(/@\[([^\]]+)\]/g, 'file `$1`'),
        llm: { baseUrl: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model },
      }))
    await projects.log(project.id, 'agent', {
      note: r.ok ? '[app] agent finished a turn' : '[app] agent failed',
      changes: [], output: r.output.slice(-2000), previewUrl: r.previewUrl,
    })
    return r
  })

export const agentPreview = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const { project: p0, app } = await requireApp(data.projectId, data.appId)
    const project = await (await svc(ProjectsService)).ensureApiToken(p0)
    const apps = await svc(AppsService)
    return withSandboxLease(app.id, async (sandbox) => {
      await sandbox.restoreIfFresh(app.id, () => apps.loadSnapshot(app.id))
      return sandbox.preview(app.id, { workspaceId: project.id, apiToken: project.api_token })
    })
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
    const { app } = await requireApp(data.projectId, data.appId)
    const apps = await svc(AppsService)
    return withSandboxLease(app.id, async (sandbox) => {
      await sandbox.restoreIfFresh(app.id, () => apps.loadSnapshot(app.id))
      return sandbox.build(app.id)
    })
  })

/** Build the app and put it behind a stable subdomain. The preview host is not shareable. */
export const publishApp = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const { app } = await requireApp(data.projectId, data.appId)
    const [apps, cfg] = [await svc(AppsService), await svc(ConfigService)]
    const slug = await apps.claimSlug(app.id)
    const r = await withSandboxLease(app.id, async (sandbox) => {
      await sandbox.restoreIfFresh(app.id, () => apps.loadSnapshot(app.id))
      return sandbox.publish(app.id, slug)
    })
    if (!r.ok) return { ok: false as const, error: r.error ?? r.stderr ?? 'Publish failed' }
    await apps.markPublished(app.id)
    // Deliberately not awaited: a publish that worked must not wait on — or fail with — a
    // screenshot. The cover shows up on the next load of the project list.
    const url = cfg.appUrl(slug)
    void (await svc(CoversService)).capture(data.projectId, app.id, url)
    return { ok: true as const, slug, files: r.files ?? 0, url }
  })

/** Take a published app offline: delete what object storage is serving and forget the subdomain. */
export const unpublishApp = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const { app } = await requireApp(data.projectId, data.appId)
    if (!app.slug) return { ok: true as const }
    await (await svc(SandboxService)).unpublish(app.id, app.slug)
    await (await svc(AppsService)).clearPublish(app.id)
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
    await (await svc(AppsService)).setSlug(app.id, slug)
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

const INTERNAL_APP_FILE = /^AGENTS\.md$/

function listSnapshotFiles(files: { path: string; content: string }[]) {
  const encoder = new TextEncoder()
  return files
    .filter((file) => !INTERNAL_APP_FILE.test(file.path))
    .map((file) => ({ path: file.path, size: encoder.encode(file.content).length }))
    .toSorted((a, b) => a.path.localeCompare(b.path))
}

export const appFiles = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const { app } = await requireApp(data.projectId, data.appId)
    const apps = await svc(AppsService)
    const snapshot = await apps.loadSnapshot(app.id)
    if (snapshot?.length) return { files: listSnapshotFiles(snapshot) }
    return withSandboxLease(app.id, async (sandbox) => {
      await sandbox.restoreIfFresh(app.id, () => apps.loadSnapshot(app.id))
      return sandbox.files(app.id)
    })
  })

export const appReadFile = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string; path: string }) => d)
  .handler(async ({ data }) => {
    const { app } = await requireApp(data.projectId, data.appId)
    const apps = await svc(AppsService)
    const snapshot = await apps.loadSnapshot(app.id)
    const file = snapshot?.find((candidate) => candidate.path === data.path)
    if (file) return { path: file.path, content: file.content }
    return withSandboxLease(app.id, async (sandbox) => {
      await sandbox.restoreIfFresh(app.id, () => apps.loadSnapshot(app.id))
      return sandbox.readFile(app.id, data.path)
    })
  })

export const appWriteFile = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string; path: string; content: string }) => d)
  .handler(async ({ data }) => {
    const { app } = await requireApp(data.projectId, data.appId)
    const apps = await svc(AppsService)
    return withSandboxLease(app.id, async (sandbox) => {
      await sandbox.restoreIfFresh(app.id, () => apps.loadSnapshot(app.id))
      const r = await sandbox.writeFile(app.id, data.path, data.content)
      await sandbox.snapshot(app.id, (files) => apps.saveSnapshot(app.id, files))
      return r
    })
  })
