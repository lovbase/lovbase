import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { applyReferenceFiles } from '../tools/reference-copy'
import { referenceDestination, referencePath } from '../src/reference-policy'
import { snapshotHost, verifySnapshotHost } from '../src/snapshot-auth'

const file = (path: string, bytes = Buffer.from([0, 255, 128, 10])) => ({ path, content: bytes.toString('base64'),
  encoding: 'base64' as const, sha256: createHash('sha256').update(bytes).digest('hex') })

describe('trusted reference copier', () => {
  test('rejects traversal, agent configs, dependency manifests, credentials and platform entrypoints', () => {
    for (const path of ['/absolute', '../escape', 'a/../b', 'a\\b', 'a\nb', 'a//b', './a', 'C:/file']) expect(() => referencePath(path)).toThrow()
    for (const path of ['package.json', 'nested/package.json', '.pi/extensions/evil.ts', 'public/AGENTS.md', '.env.local',
      'vite.config.ts', 'src/lib/lovbase.ts', 'src/lib/analytics.ts', 'src/main.tsx', '.github/workflows/evil.yml']) {
      expect(() => referenceDestination(path)).toThrow('Protected')
    }
    expect(referenceDestination('public/game/index.html')).toBe('public/game/index.html')
  })

  test('preserves binary bytes and never executes copied JavaScript or archives', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'reference-copy-')))
    try {
      const files = [file('public/game/font.woff2'), file('public/game/main.js', Buffer.from('throw new Error("never execute")')),
        file('public/downloads/local.zip', Buffer.from('opaque archive'))]
      const result = await applyReferenceFiles(root, files)
      expect(result).toEqual({ ok: true, fileCount: 3, bytes: files.reduce((sum, file) => sum + Buffer.from(file.content, 'base64').length, 0), verified: true })
      expect(await readFile(join(root, 'public/game/font.woff2'))).toEqual(Buffer.from([0, 255, 128, 10]))
      await expect(applyReferenceFiles(root, [{ ...file('bad.png'), sha256: '0'.repeat(64) }])).rejects.toThrow('integrity')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('rejects an entire batch before writing if any destination traverses a symlink', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'reference-copy-')))
    const outside = await mkdtemp(join(tmpdir(), 'reference-outside-'))
    try {
      await symlink(outside, join(root, 'linked'))
      await expect(applyReferenceFiles(root, [file('first.png'), file('linked/escape.png')])).rejects.toThrow('Symlink')
      expect(await Bun.file(join(root, 'first.png')).exists()).toBe(false)
      expect(await Bun.file(join(outside, 'escape.png')).exists()).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
  })
})

test('private snapshots use expiring, per-app signed origins and reject tampering', async () => {
  const now = Date.now()
  const host = await snapshotHost('b123456789ab', 'test-secret', now)
  expect(host.length).toBeLessThanOrEqual(63)
  expect(await verifySnapshotHost(host, 'test-secret', now)).toBe('b123456789ab')
  expect(await verifySnapshotHost(host, 'wrong-secret', now)).toBeNull()
  expect(await verifySnapshotHost(host.replace('b123456789ab', 'b123456789ac'), 'test-secret', now)).toBeNull()
  expect(await verifySnapshotHost(host, 'test-secret', now + 3600_000)).toBeNull()
  expect(await verifySnapshotHost('snap', 'test-secret', now)).toBeNull()
})
