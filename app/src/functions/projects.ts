import { createServerFn } from '@tanstack/react-start'
import { irToDDL } from '@lovbase/core/ddl'
import { planOf } from '@lovbase/core/plans'
import {
  AgentService, AnalyticsService, AppsService, AttachmentsService, ConversationService, CoversService,
  CreditsService, EdgeAnalyticsService, FILES_PREFIX, FoldersService, LlmService, ProjectsService,
  SandboxService, svc, schemaFor,
} from '@lovbase/api'
import { ApplyService, ConfigService, type ProjectCtx } from '@lovbase/api'
import { requireProject, requireUser } from './_ctx'
import { randomShareToken } from './_ids'

/** Project cap comes from the plan table; hitting it (and clicking Upgrade) is also a measurable intent signal. */
export const limitFor = (plan: string) => planOf(plan).projects

export const getProjects = createServerFn().handler(async () => {
  const { user } = await requireUser()
  const [projects, folders, credits, tiers] = await Promise.all([
    svc(ProjectsService).then((s) => s.listFor(user.id)),
    svc(FoldersService).then((s) => s.list(user.id)),
    svc(CreditsService).then((s) => s.balanceOf(user.id)),
    svc(LlmService).then((l) => l.tierOptions()),
  ])
  return {
    user,
    credits,
    // The home composer offers the same tiers as the project chat.
    tiers,
    limit: limitFor(user.plan),
    folders: folders.map((f) => ({ id: f.id, name: f.name })),
    projects: projects.map((p) => ({
      id: p.id,
      folderId: p.folder_id,
      starred: p.starred,
      // The name the first turn or the modeler settled on; the IR's own is the older source
      // and only ever meant anything once it had entities under it.
      name: p.name || (p.ir.appName && p.ir.entities.length ? p.ir.appName : ''),
      entities: p.ir.entities.length,
      tables: p.ir.entities.slice(0, 8).map((e) => e.name),
      shared: !!p.share_token,
      // A real screenshot once one has been taken; until then the card draws a wireframe, which
      // says a project exists but not which one. The key is stable because a cover replaces its
      // predecessor, so the timestamp rides along to keep a stale one out of the cache.
      cover: p.cover_app_id && p.cover_at
        ? `${FILES_PREFIX}public/thumb/${p.id}/${p.cover_app_id}.png?v=${new Date(p.cover_at).getTime()}`
        : null,
      updated_at: p.updated_at,
    })),
  }
})

export const newProject = createServerFn({ method: 'POST' }).handler(async () => {
  const { user } = await requireUser()
  const projects = await svc(ProjectsService)
  const existing = await projects.listFor(user.id)
  if (existing.length >= limitFor(user.plan)) {
    await projects.log(existing[0].id, 'paywall', { event: 'project_limit', limit: limitFor(user.plan), plan: user.plan })
    throw new Error(`LIMIT:Your current plan allows at most ${limitFor(user.plan)} projects`)
  }
  const p = await projects.create(user.id)
  // The first message is seconds behind this call, and its first tool call needs a container.
  // Start one now, so it is coming up while the person is still reading the page it lands on.
  void (await svc(AgentService)).prepare(p, p.id)
  // Handed over with the id so the page this leads to opens with nothing left to fetch: it used
  // to make this call, then navigate, then load the same state again from a cold cache.
  return { id: p.id, state: await stateOf(user, p) }
})

export const removeProject = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    const [apps, sandbox, projects] = [await svc(AppsService), await svc(SandboxService), await svc(ProjectsService)]
    // Every app of the project holds a container and possibly a published copy; the schema and
    // the workspace role go with the project itself.
    for (const app of await apps.list(project.id)) await sandbox.reclaim(app.id, app.slug)
    // And what it put in object storage. This was never swept: the rows went and the uploads
    // stayed, unreachable and still billed. Failures here must not block the delete — a stranded
    // object is a cost, a project that will not delete is a bug.
    await Promise.allSettled([
      svc(AttachmentsService).then((s) => s.deleteProject(project.id)),
      svc(CoversService).then((s) => s.deleteProject(project.id)),
    ])
    await projects.remove(project.id)
    return { ok: true }
  })

export const setShare = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; enabled: boolean }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    const token = data.enabled ? project.share_token ?? randomShareToken() : null
    await (await svc(ProjectsService)).setShareToken(project.id, token)
    return { token }
  })

export const getProjectState = createServerFn()
  .validator((d: { projectId: string }) => d)
  .handler(async ({ data }) => {
    const { user, project } = await requireProject(data.projectId)
    return stateOf(user, project)
  })

/** Everything the builder needs to open a project. */
async function stateOf(user: ProjectCtx['user'], p0: ProjectCtx['project']) {
    const projects = await svc(ProjectsService)
    const project = await projects.ensureApiToken(p0)
    const schema = schemaFor(project.id)
    const llm = await svc(LlmService)
    const cfg = await llm.configFor(user.id)
    const cfgSvc = await svc(ConfigService)
    const [log, apps, chat, live, pendingIds] = await Promise.all([
      projects.history(project.id),
      svc(AppsService).then((s) => s.list(project.id)),
      svc(ConversationService).then((s) => s.getChat(project.id)),
      svc(ConversationService).then((s) => s.liveRun(project.id)),
      svc(ApplyService).then((s) => s.listPendingIds(project.id)),
    ])
    return {
      user: { plan: user.plan },
      project: { id: project.id, name: project.name, shareToken: project.share_token, apiToken: project.api_token },
      ir: project.ir,
      schema,
      ddl: irToDDL(project.ir, schema),
      log,
      apps: await Promise.all(apps.map(async (a) => ({
        id: a.id, name: a.name, slug: a.slug, publishedAt: a.published_at,
        url: a.slug ? cfgSvc.appUrl(a.slug) : null,
        // The built copy, when there is one. Versioned by when it was taken so a rebuild is never
        // served from the previous one's cache.
        snapUrl: a.snap_at ? `/api/snap/${a.id}/?v=${Date.parse(a.snap_at)}` : null,
        snapAt: a.snap_at,
        // Whether anything has been generated for this app. Not the same as having tables: a
        // calculator or a converter is a perfectly good app with an empty data model, and gating
        // the preview on entities meant Boris could finish and still show "no data model yet".
        built: await svc(AppsService).then((s) => s.hasSnapshot(a.id)),
      }))),
      chat: chat as any,
      running: !!live,
      // The first paint already knows a turn is in flight and when it started, so a page opened
      // mid-build shows the build rather than deciding there is nothing happening.
      progress: live?.progress ?? null,
      startedAt: live?.startedAt ?? null,
      pendingIds,
      hasKey: !!cfg,
      model: llm.describe(cfg),
      // What the composer offers. Empty when the admin configured nothing, one entry when they
      // configured a single model — the picker hides itself rather than offering a choice of one.
      tiers: await llm.tierOptions(),
    }
}

// ── Folders & stars ──

export const folderCreate = createServerFn({ method: 'POST' })
  .validator((d: { name: string }) => { if (!d.name?.trim()) throw new Error('The name cannot be empty'); return { name: d.name.trim().slice(0, 40) } })
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    const f = await (await svc(FoldersService)).create(user.id, data.name)
    return { id: f.id, name: f.name }
  })

export const folderRename = createServerFn({ method: 'POST' })
  .validator((d: { id: string; name: string }) => { if (!d.name?.trim()) throw new Error('The name cannot be empty'); return { id: d.id, name: d.name.trim().slice(0, 40) } })
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    await (await svc(FoldersService)).rename(user.id, data.id, data.name)
    return { ok: true }
  })

export const folderDelete = createServerFn({ method: 'POST' })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    await (await svc(FoldersService)).remove(user.id, data.id)
    return { ok: true }
  })

export const projectMove = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; folderId: string | null }) => d)
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    await (await svc(FoldersService)).moveProject(user.id, data.projectId, data.folderId)
    return { ok: true }
  })

export const projectStar = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; starred: boolean }) => d)
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    await (await svc(FoldersService)).starProject(user.id, data.projectId, data.starred)
    return { ok: true }
  })

/**
 * Two sources, each doing only what the other cannot.
 *
 * Cloudflare counts page loads at the edge, per hostname, with the referrer and the geography —
 * unblockable, ninety-three days deep, and with nothing of ours running inside someone's generated
 * app. What it cannot do is stitch page loads into sessions, so time-on-page, bounce and pages per
 * visit come from our own beacon, which is the only thing that sees a session.
 *
 * Neither counts what the other counts. Two answers to the same question would disagree — one
 * blocked by ad blockers, one not — and the pane would be arguing with itself.
 */
export const analytics = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; days: number }) => ({ projectId: d.projectId, days: [1, 7, 30, 90].includes(d.days) ? d.days : 7 }))
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    const [apps, cfg, edge, ours] = [
      await svc(AppsService), await svc(ConfigService), await svc(EdgeAnalyticsService), await svc(AnalyticsService),
    ]
    // Traffic is measured on the published app; a preview host is our own testing, not an audience.
    const published = (await apps.list(project.id)).find((a) => a.slug && a.published_at)
    const host = published?.slug ? new URL(cfg.appUrl(published.slug)).host : null

    const [traffic, session] = await Promise.all([
      host ? edge.forHost(host, data.days).catch(() => null) : null,
      ours.report(project.id, data.days),
    ])

    return {
      host,
      edgeReady: edge.enabled,
      traffic,
      // Only the three the edge cannot answer. Everything else it answers better.
      engagement: {
        viewsPerVisit: session.viewsPerVisit,
        avgDurationMs: session.avgDurationMs,
        bounce: session.bounce,
      },
    }
  })
