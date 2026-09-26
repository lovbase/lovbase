import type { UIMessage } from 'ai'
import type { Tier } from '@lovbase/core/billing'

export const ACTIVE_JOB_STATUSES = ['queued', 'waiting_capacity', 'starting', 'running', 'finalizing'] as const
export type ActiveJobStatus = typeof ACTIVE_JOB_STATUSES[number]
export type JobStatus = ActiveJobStatus | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'interrupted'

export type TurnJobInput = {
  appId: string
  messages: UIMessage[]
  tier?: Tier
}

export type JobRow = {
  id: string
  request_id: string
  run_id: string
  project_id: string
  app_id: string
  user_id: string
  status: JobStatus
  input: TurnJobInput
  attempt: number
  worker_id: string | null
  error: string | null
  cancel_requested_at: Date | null
  enqueued_at: Date | null
  started_at: Date | null
  finished_at: Date | null
  created_at: Date
  updated_at: Date
}

export type JobState = {
  id: string
  runId: string
  status: JobStatus
  createdAt: number
  startedAt: number | null
  cancelRequested: boolean
  queuePosition: number | null
}
