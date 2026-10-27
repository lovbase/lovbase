import { createServerFn } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'
import { FeedbackService, JobRepository, svc } from '@lovbase/api'
import { feedbackInput, feedbackStatus } from '@lovbase/core/feedback'
import { z } from 'zod'
import { requireAdmin, requireUser } from './_ctx'

export const submitFeedback = createServerFn({ method: 'POST' }).validator(feedbackInput)
  .handler(async ({ data }) => (await svc(FeedbackService)).submit(await requireUser(), data))

export const adminFeedback = createServerFn({ method: 'POST' })
  .validator(z.object({ status: feedbackStatus.optional(), offset: z.number().int().min(0).max(100000).default(0) }))
  .handler(async ({ data }) => (await svc(FeedbackService)).list(await requireAdmin(), data.status, data.offset))

export const adminFeedbackStatus = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid(), status: feedbackStatus }))
  .handler(async ({ data }) => {
    await (await svc(FeedbackService)).setStatus(await requireAdmin(), data.id, data.status)
    return { ok: true }
  })

export const myNotifications = createServerFn().handler(async () => {
  const { user } = await requireUser()
  setResponseHeader('Cache-Control', 'private, no-store')
  return (await svc(JobRepository)).notifications(user.id)
})

export const readNotifications = createServerFn({ method: 'POST' })
  .validator(z.object({ ids: z.array(z.string().min(1).max(100)).max(50) }))
  .handler(async ({ data }) => {
    const { user } = await requireUser()
    await (await svc(JobRepository)).readNotifications(user.id, data.ids)
    return { ok: true }
  })
