import { createServerFn } from '@tanstack/react-start'
import { DemoService, svc } from '@lovbase/api'
import { requireUser } from './_ctx'

/** Template demos: any signed-in user can open one; they are system-owned and read-only. */
export const templatePreview = createServerFn({ method: 'POST' })
  .validator((d: { templateId: string }) => d)
  .handler(async ({ data }) => {
    await requireUser()
    return (await svc(DemoService)).preview(data.templateId)
  })
