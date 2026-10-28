import { describe, expect, spyOn, test } from 'bun:test'
import { buildInto, PreviewDeadline, PreviewCleanupError } from '../src/app'
import type { SandboxBackend, StaticStore } from '../src/backend'
import { pack } from '../src/pack'

function fixture(failure?: 'list' | 'put' | 'prune' | 'commit' | 'build') {
  const objects = new Map([
    ['demo/index.html', { bytes: new TextEncoder().encode('old document'), contentType: 'text/html' }],
    ['demo/old.js', { bytes: new TextEncoder().encode('old asset'), contentType: 'text/javascript' }],
  ])
  const initial = structuredClone(objects)
  let failed = false,
    reserved = 0,
    aborted = 0,
    committed = 0,
    calls = 0
  const store: StaticStore = {
    async list(prefix) {
      if (failure === 'list') throw new Error('listing failed')
      return [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.bytes.length }))
    },
    async get(key) {
      return objects.get(key) ?? null
    },
    async put(key, bytes, contentType) {
      // Simulate a response lost after a partial write.
      objects.set(key, { bytes, contentType })
      if (failure === 'put' && !failed) {
        failed = true
        throw new Error('upload failed')
      }
    },
    async deletePrefix(prefix, keep) {
      let removed = 0
      for (const key of objects.keys())
        if (key.startsWith(prefix) && !keep?.has(key)) {
          objects.delete(key)
          removed++
        }
      if (failure === 'prune' && !failed) {
        failed = true
        throw new Error('prune failed')
      }
      return removed
    },
  }
  const sb = {
    async exec() {
      calls++
      if (calls === 1) return { success: failure !== 'build', stdout: '', stderr: 'compile error' }
      return {
        success: true,
        stderr: '',
        stdout: pack([
          { path: 'index.html', content: 'new document' },
          { path: 'new.js', content: 'new asset' },
        ]),
      }
    },
  } as unknown as SandboxBackend
  const quota = {
    async reserve(bytes: number) {
      reserved = bytes
      return 'reservation'
    },
    async commit() {
      if (failure === 'commit') throw new Error('commit failed')
      committed++
    },
    async abort() {
      aborted++
    },
  }
  return { objects, initial, sb, store, quota, state: () => ({ reserved, aborted, committed, calls }) }
}

describe('durable build quota and rollback', () => {
  for (const failure of ['list', 'put', 'prune', 'commit'] as const)
    test(`${failure} failure preserves the complete previous build and releases reservation`, async () => {
      const f = fixture(failure)
      await expect(buildInto(f.sb, f.store, 'demo', undefined, f.quota)).rejects.toThrow()
      expect(f.objects).toEqual(f.initial)
      expect(f.state().aborted).toBe(1)
      expect(f.state().committed).toBe(0)
    })
  test('successful replacement accounts new bytes and removes obsolete assets', async () => {
    const f = fixture()
    expect(await buildInto(f.sb, f.store, 'demo', undefined, f.quota)).toMatchObject({
      ok: true,
      files: 2,
      removed: 1,
      bytes: 21,
    })
    expect([...f.objects.keys()].sort()).toEqual(['demo/index.html', 'demo/new.js'])
    expect(f.state()).toMatchObject({ reserved: 21, committed: 1, aborted: 0 })
  })
  test('failed compilation cannot publish a stale dist tree', async () => {
    const f = fixture('build')
    expect(await buildInto(f.sb, f.store, 'demo', undefined, f.quota)).toMatchObject({
      ok: false,
      error: 'Build failed',
    })
    expect(f.objects).toEqual(f.initial)
    expect(f.state()).toMatchObject({ reserved: 0, calls: 1 })
  })

  test('upload timeout drains a late write before restoring the entire old preview', async () => {
    const f = fixture()
    let now = 100, release!: () => void, uploadStarted!: () => void
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { uploadStarted = resolve })
    const put = f.store.put
    let first = true
    f.store.put = async (...args) => {
      if (first) { first = false; uploadStarted(); await gate }
      await put(...args)
    }
    try {
      const result = buildInto(f.sb, f.store, 'demo', undefined, f.quota, 30)
      await started
      now = 131
      expect(f.state().aborted).toBe(0)
      release()
      await expect(result).rejects.toBeInstanceOf(PreviewDeadline)
      expect(f.objects).toEqual(f.initial)
      expect(f.state()).toMatchObject({ aborted: 1, committed: 0 })
    } finally { release(); clock.mockRestore() }
  })

  test('a reservation that arrives after the deadline is still released', async () => {
    const f = fixture()
    let now = 0
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    const reserve = f.quota.reserve
    f.quota.reserve = async bytes => { const id = await reserve(bytes); now = 31; return id }
    try {
      await expect(buildInto(f.sb, f.store, 'demo', undefined, f.quota, 30)).rejects.toBeInstanceOf(PreviewDeadline)
      expect(f.objects).toEqual(f.initial)
      expect(f.state()).toMatchObject({ aborted: 1, committed: 0 })
    } finally { clock.mockRestore() }
  })

  test('failed rollback retains accounting reservation and reports that the old preview is uncertain', async () => {
    const f = fixture('put')
    const put = f.store.put
    let calls = 0
    f.store.put = async (...args) => { if (++calls > 1) throw new Error('rollback unavailable'); await put(...args) }
    await expect(buildInto(f.sb, f.store, 'demo', undefined, f.quota, 30_000)).rejects.toBeInstanceOf(PreviewCleanupError)
    expect(f.state()).toMatchObject({ aborted: 0, committed: 0 })
  })
})
