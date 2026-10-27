import { z } from 'zod'

export const FEEDBACK_IMAGE_BYTES = 2 * 1024 * 1024
export const FEEDBACK_IMAGE_COUNT = 3
export const feedbackInput = z.object({
  id: z.string().uuid(),
  kind: z.enum(['suggestion', 'bug', 'other']),
  message: z.string().trim().min(1).max(5000),
  projectId: z.string().max(100).optional(),
  page: z.string().max(500).regex(/^\/(?!\/)/).default('/home'),
  screenshots: z.array(z.object({
    name: z.string().min(1).max(150),
    dataUrl: z.string().max(Math.ceil(FEEDBACK_IMAGE_BYTES / 3) * 4 + 100),
  })).max(FEEDBACK_IMAGE_COUNT).default([]),
})
export const feedbackStatus = z.enum(['new', 'reviewing', 'resolved'])
export type FeedbackInput = z.infer<typeof feedbackInput>
export type FeedbackStatus = z.infer<typeof feedbackStatus>
