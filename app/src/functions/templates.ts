import { createServerFn } from '@tanstack/react-start'
import {
  AppsService, CommunityTemplatesService, ConfigService, InventoryService, Product3dService, TemplatesService,
  categoryInput, publishTemplateInput, remixInput, svc,
} from '@lovbase/api'
import { templates, templateById } from '@lovbase/core/templates'
import { z } from 'zod'
import { currentUser, requireAdmin, requireApp, requireProject, requireUser } from './_ctx'

export const getTemplates = createServerFn().handler(async () => ({
  templates,
  user: await currentUser(),
}))
export const getTemplate = createServerFn()
  .validator(z.object({ templateId: z.string().min(1).max(80) }))
  .handler(async ({ data }) => {
    const template = templateById(data.templateId)
    if (!template) throw new Error('Template not found')
    if (template.id === 'inkwave')
      return {
        templateId: 'inkwave' as const,
        template,
        previewUrl: '/templates/inkwave/game/index.html',
      }
    const projectId = await (await svc(TemplatesService)).ensureDemo(template.id, template.version)
    if (template.id === 'product-3d')
      return {
        templateId: 'product-3d' as const,
        template,
        data: await (await svc(Product3dService)).read(projectId),
      }
    return {
      templateId: 'inventory' as const,
      template,
      data: await (await svc(InventoryService)).read(projectId),
    }
  })
export const createProjectFromTemplate = createServerFn({ method: 'POST' })
  .validator(remixInput)
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    return (await svc(TemplatesService)).create(user.id, data)
  })

// ── Community templates ──

/** Everything the gallery shows besides the built-ins: categories and approved community templates. */
export const getCommunityTemplates = createServerFn().handler(async () => {
  const community = await svc(CommunityTemplatesService)
  const [categories, items] = await Promise.all([community.categories(), community.gallery()])
  return { categories, items }
})

export const getCommunityTemplate = createServerFn()
  .validator(z.object({ id: z.string().min(1).max(40) }))
  .handler(async ({ data }) => {
    const user = await currentUser()
    const t = await (await svc(CommunityTemplatesService)).get(data.id, user ?? undefined)
    return { ...t, liveUrl: t.liveSlug ? (await svc(ConfigService)).appUrl(t.liveSlug) : null }
  })

export const useCommunityTemplate = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().min(1).max(40), name: z.string().trim().min(1).max(80), requestId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    return (await svc(CommunityTemplatesService)).use(user.id, data.id, data.name, data.requestId)
  })

/**
 * The publish form: the categories to pick from, the app it is about, and what that app already
 * has in review. Opened from a project card there is no app yet: the most recently published one
 * is the one a template would be made from.
 */
export const getTemplateDraft = createServerFn()
  .validator(z.object({ projectId: z.string().min(1), appId: z.string().min(1).optional() }))
  .handler(async ({ data }) => {
    const { user } = await requireProject(data.projectId)
    const apps = await (await svc(AppsService)).list(data.projectId)
    const app = data.appId
      ? apps.find((a) => a.id === data.appId)
      : apps.filter((a) => a.published_at).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0] ?? apps[0]
    const community = await svc(CommunityTemplatesService)
    return {
      categories: await community.categories(),
      app: app ? { id: app.id, name: app.name, published: !!app.published_at } : null,
      current: app ? await community.forApp(user.id, app.id) : null,
    }
  })

export const publishTemplate = createServerFn({ method: 'POST' })
  .validator(publishTemplateInput)
  .handler(async ({ data }) => {
    const { user } = await requireApp(data.projectId, data.appId)
    return (await svc(CommunityTemplatesService)).publish(user.id, data)
  })

export const withdrawTemplate = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().min(1).max(40) }))
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    await (await svc(CommunityTemplatesService)).withdraw(user.id, data.id)
    return { ok: true }
  })

// ── Admin: review and categories ──

export const adminTemplates = createServerFn().handler(async () => {
  await requireAdmin()
  const community = await svc(CommunityTemplatesService)
  const [categories, items] = await Promise.all([community.categories(), community.review()])
  return { categories, items }
})

export const adminReviewTemplate = createServerFn({ method: 'POST' })
  .validator(z.object({
    id: z.string().min(1).max(40),
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    featured: z.boolean().optional(),
    note: z.string().trim().max(500).nullable().optional(),
    categoryId: z.string().max(40).nullable().optional(),
    tags: z.array(z.string().trim().max(20)).max(5).optional(),
  }))
  .handler(async ({ data: { id, ...patch } }) => {
    const { user } = await requireAdmin()
    await (await svc(CommunityTemplatesService)).decide(id, user.email, patch)
    return { ok: true }
  })

export const adminSaveTemplateCategory = createServerFn({ method: 'POST' })
  .validator(categoryInput)
  .handler(async ({ data }) => {
    await requireAdmin()
    await (await svc(CommunityTemplatesService)).saveCategory(data)
    return { ok: true }
  })

export const adminDeleteTemplateCategory = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().min(1).max(40) }))
  .handler(async ({ data }) => {
    await requireAdmin()
    await (await svc(CommunityTemplatesService)).deleteCategory(data.id)
    return { ok: true }
  })
