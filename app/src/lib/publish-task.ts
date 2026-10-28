import type { PublishTaskState } from '@lovbase/api'

export const publishing = (task: PublishTaskState | null) => !!task &&
  ['queued', 'waiting_capacity', 'starting', 'running', 'finalizing', 'cancelling'].includes(task.status)

/** SSE and the submit response may arrive in either order. Terminal states are final. */
export function latestPublishTask(current: PublishTaskState | null, next: PublishTaskState | null): PublishTaskState | null {
  if (!next) return current
  if (!current) return next
  if (next.createdAt < current.createdAt) return current
  if (next.id === current.id && !publishing(current)) return current
  return next
}
