import { createServerFn } from '@tanstack/react-start'
import { planOf } from '@lovbase/core/plans'
import {
  AppsService, ConfigService, LlmService, ProjectsService, RESERVED_SUBDOMAINS, SandboxService,
  looksLikePreviewHost, svc,
} from '@lovbase/api'
import { requireApp, requireProject } from './_ctx'

// ── App builder (sandbox + pi) ──

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
    if (!cfg) throw new Error('平台还没有配置模型,请联系管理员')
    await projects.log(project.id, 'user', { message: '[app] ' + data.prompt })
    const r = await (await svc(SandboxService)).run(app.id, {
      workspaceId: project.id,
      apiToken: project.api_token,
      prompt: data.prompt.replace(/@\[([^\]]+)\]/g, '文件 `$1`'),
      llm: { baseUrl: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model },
    })
    await projects.log(project.id, 'agent', {
      note: r.ok ? '[app] agent 完成一轮' : '[app] agent 出错',
      changes: [], output: r.output.slice(-2000), previewUrl: r.previewUrl,
    })
    return r
  })

export const agentPreview = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const { project: p0, app } = await requireApp(data.projectId, data.appId)
    const project = await (await svc(ProjectsService)).ensureApiToken(p0)
    const [sandbox, apps] = [await svc(SandboxService), await svc(AppsService)]
    // The container may have been evicted since the last visit, which wipes its filesystem.
    await sandbox.restoreIfFresh(app.id, () => apps.loadSnapshot(app.id))
    return sandbox.preview(app.id, { workspaceId: project.id, apiToken: project.api_token })
  })

export const agentBuild = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const { app } = await requireApp(data.projectId, data.appId)
    const [sandbox, apps] = [await svc(SandboxService), await svc(AppsService)]
    await sandbox.restoreIfFresh(app.id, () => apps.loadSnapshot(app.id))
    return sandbox.build(app.id)
  })

/** Build the app and put it behind a stable subdomain. The preview host is not shareable. */
export const publishApp = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const { app } = await requireApp(data.projectId, data.appId)
    const [sandbox, apps, cfg] = [await svc(SandboxService), await svc(AppsService), await svc(ConfigService)]
    await sandbox.restoreIfFresh(app.id, () => apps.loadSnapshot(app.id))
    const slug = await apps.claimSlug(app.id)
    const r = await sandbox.publish(app.id, slug)
    if (!r.ok) return { ok: false as const, error: r.error ?? r.stderr ?? '发布失败' }
    await apps.markPublished(app.id)
    return { ok: true as const, slug, files: r.files ?? 0, url: cfg.appUrl(slug) }
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
    if (!planOf(user.plan).customSubdomain) throw new Error('LIMIT:自定义子域名是 Pro 及以上套餐的功能')
    const slug = data.slug.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) throw new Error('只能用小写字母、数字和连字符,2 到 41 个字符')
    if (RESERVED_SUBDOMAINS.has(slug) || looksLikePreviewHost(slug)) throw new Error('这个子域名被保留了,换一个')
    // SlugTaken is already a DomainError with the message the UI shows; wrapping it only lost the stack.
    await (await svc(AppsService)).setSlug(app.id, slug)
    return { ok: true as const, slug, url: (await svc(ConfigService)).appUrl(slug) }
  })

// ── Apps of a workspace ──

export const appCreate = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; name: string }) => ({ projectId: d.projectId, name: (d.name || '新应用').trim().slice(0, 40) }))
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
    if ((await apps.list(project.id)).length <= 1) throw new Error('至少保留一个应用')
    await (await svc(SandboxService)).reclaim(app.id, app.slug)
    await apps.remove(project.id, app.id)
    return { ok: true }
  })

// ── App source files (live in the sandbox container) ──

export const appFiles = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    const { app } = await requireApp(data.projectId, data.appId)
    return (await svc(SandboxService)).files(app.id)
  })

export const appReadFile = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string; path: string }) => d)
  .handler(async ({ data }) => {
    const { app } = await requireApp(data.projectId, data.appId)
    return (await svc(SandboxService)).readFile(app.id, data.path)
  })

export const appWriteFile = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string; path: string; content: string }) => d)
  .handler(async ({ data }) => {
    const { app } = await requireApp(data.projectId, data.appId)
    return (await svc(SandboxService)).writeFile(app.id, data.path, data.content)
  })
