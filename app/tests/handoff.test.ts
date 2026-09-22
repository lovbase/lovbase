import { describe, expect, test } from 'bun:test'
import { stashStart, takeStart, type ProjectStart } from '../src/lib/handoff'

// The home page hands the project page everything it computed, in memory. The page takes it once
// and only for the project it was meant for: a stale handover must never open some other project
// on a state that is not its own.

const start = (projectId: string): ProjectStart =>
  ({ projectId, prompt: 'p', files: [], state: {} as ProjectStart['state'], shell: {} as ProjectStart['shell'] })

describe('takeStart', () => {
  test('hands the start over once', () => {
    stashStart(start('a1'))
    expect(takeStart('a1')?.projectId).toBe('a1')
    expect(takeStart('a1')).toBeNull()
  })

  test('refuses a start meant for another project, and keeps it for the right one', () => {
    stashStart(start('a2'))
    expect(takeStart('zz')).toBeNull()
    expect(takeStart('a2')?.projectId).toBe('a2')
  })

  test('nothing stashed is nothing to take', () => {
    expect(takeStart('a3')).toBeNull()
  })
})
