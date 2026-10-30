import { expect, test } from 'bun:test'
import { activeJob, chatErrorKind, jobStatusLabel, recoveryMessage } from '../src/lib/chat-recovery'
import type { JobState } from '@lovbase/api'

const job = (recovery: JobState['recovery'], status: JobState['status'] = 'finalizing') => ({ status, recovery } as JobState)
const t = (_key: string, fallback: string) => fallback

test('background publishing reports its actual phase without claiming a disconnected chat', () => {
  const publish = { ...job({}, 'waiting_capacity'), operation: 'publish' as const }
  expect(jobStatusLabel(t, publish)).toBe('Publishing is queued, waiting for available resources…')
  expect(jobStatusLabel(t, { ...publish, status: 'running' })).toBe('Building and publishing…')
  expect(jobStatusLabel(t, { ...publish, status: 'finalizing' })).toBe('Finishing publication…')
  expect(jobStatusLabel(t, { ...publish, status: 'failed' })).toBe('Publication failed. Please try again.')
  // Older snapshots omit operation; they still describe the job instead of a transport failure.
  expect(jobStatusLabel(t, job({}, 'waiting_capacity'))).toBe('Waiting for available resources…')
  expect(jobStatusLabel(() => '前方还有 {n} 个任务', { ...job({}, 'queued'), queuePosition: 3 })).toBe('前方还有 3 个任务')
})

test('old and new conflict responses reconnect without displaying JSON; unrelated errors are not paywalls', () => {
  expect(chatErrorKind(new Error('{"error":"active_project_job"}'))).toBe('conflict')
  expect(chatErrorKind(new Error('A task for this project is already queued or running'))).toBe('conflict')
  expect(chatErrorKind(new Error('Credits used up'))).toBe('credits')
  expect(chatErrorKind(new Error('Failed loading credits settings'))).toBe('other')
  expect(activeJob(null)).toBe(false)
  expect(activeJob(job({}, 'interrupted'))).toBe(false)
})

test('save acknowledgments, deadline cleanup and preview fallback use durable results', () => {
  expect(recoveryMessage(job({ sourceStatus: 'saving' }), 0)).toBe('saving')
  expect(recoveryMessage(job({ sourceStatus: 'failed', hadPreview: true }), 0)).toBe('saveFailed')
  const saving = job({ sourceStatus: 'saved', previewStatus: 'saving', previewStartedAt: 100 })
  expect(recoveryMessage(saving, 30_099)).toBe('preview')
  expect(recoveryMessage(saving, 30_100)).toBe('cleanup')
  expect(recoveryMessage(job({ sourceStatus: 'saved', previewStatus: 'ready' }, 'interrupted'), 0)).toBe('ready')
  expect(recoveryMessage(job({ sourceStatus: 'saved', previewStatus: 'timed_out', hadPreview: true }, 'interrupted'), 0)).toBe('oldPreview')
  expect(recoveryMessage(job({ sourceStatus: 'saved', previewStatus: 'failed', hadPreview: false }, 'interrupted'), 0)).toBe('noPreview')
  expect(recoveryMessage(job({ sourceStatus: 'saving' }, 'interrupted'), 0)).toBe('saveFailed')
})
