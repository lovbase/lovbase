import { createServerFn } from '@tanstack/react-start'
import { InventoryService, TemplatesService, remixInput, svc } from '@lovbase/api'
import { templates, templateById } from '@lovbase/core/templates'
import { currentUser, requireUser } from './_ctx'

export const getTemplates = createServerFn().handler(async () => ({ templates, user: await currentUser() }))
export const getTemplate = createServerFn()
  .validator((data: { templateId: string }) => data)
  .handler(async ({ data }) => {
    const template = templateById(data.templateId)
    if (!template) throw new Error('Template not found')
    const projectId = await (await svc(TemplatesService)).ensureDemo()
    return { template, data: await (await svc(InventoryService)).read(projectId) }
  })
export const createProjectFromTemplate = createServerFn({ method: 'POST' })
  .validator(remixInput)
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    return (await svc(TemplatesService)).create(user.id, data)
  })
