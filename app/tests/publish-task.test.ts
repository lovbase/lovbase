import { expect, test } from 'bun:test'
import type { PublishTaskState } from '@lovbase/api'
import { latestPublishTask, publishing } from '../src/lib/publish-task'

const queued: PublishTaskState = { id: 'publish-1', createdAt: 1000, status: 'queued', error: null, files: 0 }

test('a completion arriving before the submit response stays terminal and duplicates retain identity', () => {
  for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
    const completed = { ...queued, status, files: 72 }
    expect(latestPublishTask(completed, queued)).toBe(completed)
    expect(latestPublishTask(completed, { ...completed })).toBe(completed)
    expect(publishing(completed)).toBe(false)
  }
})

test('newer tasks replace previous results, and late snapshots of older tasks are ignored', () => {
  const newer = { ...queued, id: 'publish-2', createdAt: 2000 }
  expect(latestPublishTask({ ...queued, status: 'succeeded' }, newer)).toBe(newer)
  expect(latestPublishTask(newer, { ...queued, status: 'succeeded' })).toBe(newer)
  expect(latestPublishTask(newer, null)).toBe(newer)
  expect(latestPublishTask(null, null)).toBeNull()
  expect(latestPublishTask(null, newer)).toBe(newer)
  expect(publishing(newer)).toBe(true)
})
