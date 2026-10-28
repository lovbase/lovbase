import type { JobRow, JobStatus } from './job.types'

export type PublishTaskState = {
  id: string
  createdAt: number
  status: JobStatus
  error: string | null
  files: number
}

export type PublishSnapshot = { task: PublishTaskState | null }

export function publishState(job: JobRow): PublishTaskState {
  return { id: job.id, createdAt: new Date(job.created_at).getTime(), status: job.status,
    error: job.error, files: typeof job.result?.files === 'number' ? job.result.files : 0 }
}
