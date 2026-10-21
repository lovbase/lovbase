import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDockerFile } from '../runner/write-file'

describe('Docker source transfer', () => {
  test('large Unicode snapshots round-trip without oversized arguments or shell expansion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lovbase-transfer-'))
    try {
      const path = join(dir, 'nested', 'source $(unused).txt')
      const content = '库存 🚀 "quotes" $(not-a-command)\n'.repeat(15000)
      await writeDockerFile(
        async (args, env = []) => {
          expect(args.every((arg) => Buffer.byteLength(arg) < 65536)).toBe(true)
          expect(env.every((entry) => Buffer.byteLength(entry) < 65536)).toBe(true)
          const proc = Bun.spawn(args, {
            env: {
              ...process.env,
              ...Object.fromEntries(
                env.map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]),
              ),
            },
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const stderr = await new Response(proc.stderr).text()
          return { success: (await proc.exited) === 0, stderr }
        },
        path,
        content,
      )
      expect(await readFile(path, 'utf8')).toBe(content)
      expect(await readdir(join(dir, 'nested'))).toEqual(['source $(unused).txt'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('a failed transfer preserves the previous file and cleans its temporary file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lovbase-transfer-'))
    try {
      const path = join(dir, 'source.txt')
      await writeFile(path, 'previous source')
      await expect(
        writeDockerFile(
          async (args, env) => {
            if (env) return { success: false, stderr: 'transfer failed' }
            const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
            return { success: (await proc.exited) === 0, stderr: '' }
          },
          path,
          'replacement',
        ),
      ).rejects.toThrow('transfer failed')
      expect(await readFile(path, 'utf8')).toBe('previous source')
      expect(await readdir(dir)).toEqual(['source.txt'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
