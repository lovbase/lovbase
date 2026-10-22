import { createServerFn } from '@tanstack/react-start'
import { InventoryService, Product3dService, TemplatesService, remixInput, svc } from '@lovbase/api'
import { templates, templateById } from '@lovbase/core/templates'
import { z } from 'zod'
import { currentUser, requireUser } from './_ctx'

export const getTemplates = createServerFn().handler(async () => ({
  templates,
  user: await currentUser(),
}))
export const getTemplate = createServerFn()
  .validator(z.object({ templateId: z.string().min(1).max(80) }))
  .handler(async ({ data }) => {
    const template = templateById(data.templateId)
    if (!template) throw new Error('Template not found')
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
