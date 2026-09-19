import { createServerFn } from '@tanstack/react-start'
import { irToDDL } from '@lovbase/core/ddl'
import { planOf } from '@lovbase/core/plans'
import {
  AnalyticsService, AppsService, ConversationService, CreditsService, FoldersService, LlmService,
  ProjectsService, SandboxService, svc, schemaFor,
} from '@lovbase/api'
import { ApplyService, ConfigService } from '@lovbase/api'
import { requireProject, requireUser } from './_ctx'
import { randomShareToken } from './_ids'

/** Project cap comes from the plan table; hitting it (and clicking 升级) is also a measurable intent signal. */
export const limitFor = (plan: string) => planOf(plan).projects

export const getProjects = createServerFn().handler(async () => {
  const { user } = await requireUser()
  const [projects, folders, credits] = await Promise.all([
    svc(ProjectsService).then((s) => s.listFor(user.id)),
    svc(FoldersService).then((s) => s.list(user.id)),
    svc(CreditsService).then((s) => s.balanceOf(user.id)),
  ])
  return {
    user,
    credits,
    limit: limitFor(user.plan),
    folders: folders.map((f) => ({ id: f.id, name: f.name })),
    projects: projects.map((p) => ({
      id: p.id,
      folderId: p.folder_id,
      starred: p.starred,
      name: p.ir.appName && p.ir.entities.length ? p.ir.appName : '',
      entities: p.ir.entities.length,
      tables: p.ir.entities.slice(0, 8).map((e) => e.name),
      shared: !!p.share_token,
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
    throw new Error(`LIMIT:当前套餐最多 ${limitFor(user.plan)} 个项目`)
  }
  const p = await projects.create(user.id)
  return { id: p.id }
})

export const removeProject = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    const [apps, sandbox, projects] = [await svc(AppsService), await svc(SandboxService), await svc(ProjectsService)]
    // Every app of the project holds a container and possibly a published copy; the schema and
    // the workspace role go with the project itself.
    for (const app of await apps.list(project.id)) await sandbox.reclaim(app.id, app.slug)
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
    const { user, project: p0 } = await requireProject(data.projectId)
    const projects = await svc(ProjectsService)
    const project = await projects.ensureApiToken(p0)
    const schema = schemaFor(project.id)
    const llm = await svc(LlmService)
    const cfg = await llm.configFor(user.id)
    const cfgSvc = await svc(ConfigService)
    const [log, apps, chat, running, pendingIds] = await Promise.all([
      projects.history(project.id),
      svc(AppsService).then((s) => s.list(project.id)),
      svc(ConversationService).then((s) => s.getChat(project.id)),
      svc(ConversationService).then((s) => s.runActive(project.id)),
      svc(ApplyService).then((s) => s.listPendingIds(project.id)),
    ])
    return {
      user: { plan: user.plan },
      project: { id: project.id, shareToken: project.share_token, apiToken: project.api_token },
      ir: project.ir,
      schema,
      ddl: irToDDL(project.ir, schema),
      log,
      apps: apps.map((a) => ({
        id: a.id, name: a.name, slug: a.slug, publishedAt: a.published_at,
        url: a.slug ? cfgSvc.appUrl(a.slug) : null,
      })),
      chat: chat as any,
      running,
      pendingIds,
      hasKey: !!cfg,
      model: llm.describe(cfg),
    }
  })

// ── Folders & stars ──

export const folderCreate = createServerFn({ method: 'POST' })
  .validator((d: { name: string }) => { if (!d.name?.trim()) throw new Error('名字不能为空'); return { name: d.name.trim().slice(0, 40) } })
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    const f = await (await svc(FoldersService)).create(user.id, data.name)
    return { id: f.id, name: f.name }
  })

export const folderRename = createServerFn({ method: 'POST' })
  .validator((d: { id: string; name: string }) => { if (!d.name?.trim()) throw new Error('名字不能为空'); return { id: d.id, name: d.name.trim().slice(0, 40) } })
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

export const analytics = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; days: number }) => ({ projectId: d.projectId, days: [1, 7, 30, 90].includes(d.days) ? d.days : 7 }))
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    return (await svc(AnalyticsService)).report(project.id, data.days)
  })
