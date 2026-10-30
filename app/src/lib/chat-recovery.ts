import type { JobState } from '@lovbase/api'

export const activeJob = (job: JobState | null | undefined) => !!job
  && ['queued', 'waiting_capacity', 'starting', 'running', 'finalizing', 'cancelling'].includes(job.status)

export function jobStatusLabel(t: (key: string, fallback: string) => string, job: JobState): string {
  if (job.operation === 'publish') {
    switch (job.status) {
      case 'queued': return t('chat.publish.queued', 'Publishing is queued…')
      case 'waiting_capacity': return t('chat.publish.capacity', 'Publishing is queued, waiting for available resources…')
      case 'starting': return t('chat.publish.starting', 'Preparing to publish…')
      case 'running': return t('chat.publish.running', 'Building and publishing…')
      case 'finalizing': return t('chat.publish.finalizing', 'Finishing publication…')
      case 'cancelling': return t('chat.publish.cancelling', 'Cancelling publication…')
      case 'cancelled': return t('chat.publish.cancelled', 'Publication cancelled')
      case 'interrupted': return t('chat.publish.interrupted', 'Publication interrupted. Please try again.')
      case 'failed': return t('chat.publish.failed', 'Publication failed. Please try again.')
      case 'succeeded': return t('chat.publish.succeeded', 'Published')
    }
  }
  switch (job.status) {
    case 'queued': return job.queuePosition
      ? t('chat.job.queuedAhead', 'Queued · {n} task(s) ahead').replace('{n}', String(job.queuePosition))
      : t('chat.job.queued', 'Queued')
    case 'waiting_capacity': return t('chat.job.capacity', 'Waiting for available resources…')
    case 'starting': return t('chat.job.starting', 'Starting preview')
    case 'running': return t('chat.job.running', 'Running')
    case 'finalizing': return t('chat.job.finalizing', 'Saving static preview')
    case 'cancelling': return t('chat.job.cancelling', 'Cancelling')
    case 'cancelled': return t('chat.job.cancelled', 'Cancelled')
    case 'interrupted': return t('chat.job.interrupted', 'Interrupted')
    case 'failed': return t('chat.job.failed', 'Failed')
    case 'succeeded': return t('chat.job.succeeded', 'Finished')
  }
}

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
