import type { JobState } from '@lovbase/api'

export const activeJob = (job: JobState | null | undefined) => !!job
  && ['queued', 'waiting_capacity', 'starting', 'running', 'finalizing', 'cancelling'].includes(job.status)

export function chatErrorKind(error: Error): 'credits' | 'conflict' | 'other' {
  if (/active_project_job|A task for this project is already queued or running/i.test(error.message)) return 'conflict'
  if (/out_of_credits|credits used up|not enough credits|insufficient credits/i.test(error.message)) return 'credits'
  return 'other'
}

/** Labels depend on durable save results, never on a disconnected transport's optimistic state. */
export function recoveryMessage(job: JobState, now: number) {
  const r = job.recovery
  if (!r) return 'checking' as const
  if (r.sourceStatus === 'failed') return 'saveFailed' as const
  if (r.sourceStatus !== 'saved') return activeJob(job) ? 'saving' as const : 'saveFailed' as const
  if (r.previewStatus === 'saving') return !activeJob(job) ? 'noPreview' as const
    : r.previewStartedAt && now - r.previewStartedAt >= 30_000 ? 'cleanup' as const : 'preview' as const
  if (r.previewStatus === 'ready') return 'ready' as const
  return r.hadPreview ? 'oldPreview' as const : 'noPreview' as const
}
