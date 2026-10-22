import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { APP, sandboxApi } from '../src/app'
import type { SandboxBackend, SandboxCtx } from '../src/backend'

function fixture() {
  const files = new Map([[`${APP}/package.json`, '{"dependencies":{}}']])
  const commands: string[] = []
  let failInstall = false
  const backend: SandboxBackend = {
    async exec(command) {
      commands.push(command)
      const failed = failInstall && command.includes('bun install')
      return { success: !failed, stdout: '', stderr: failed ? 'registry unavailable' : '' }
    },
    async exists(path) {
      return files.has(path)
    },
    async readFile(path) {
      const value = files.get(path)
      if (value === undefined) throw new Error('missing')
      return value
    },
    async writeFile(path, content) {
      files.set(path, content)
    },
    async listFiles() {
      return []
    },
    async preview() {
      return { previewUrl: 'http://preview.test' }
    },
    async logs() {
      return { running: false }
    },
    async stop() {},
    async destroy() {},
  }
  const ctx: SandboxCtx = {
    token: 'test-token',
    config: { apiUrl: 'http://api.test', publicApiUrl: 'http://api.test' },
    backend: () => backend,
  }
  const app = new Hono<{ Variables: { sandbox: SandboxCtx } }>()
    .use('*', async (c, next) => {
      c.set('sandbox', ctx)
      await next()
    })
    .route('/', sandboxApi)
  const restore = (withManifest = true) =>
    app.request('/apps/studio/import', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        files: withManifest
          ? [{ path: 'package.json', content: '{"dependencies":{"three":"^0.180.0"}}' }]
          : [{ path: 'src/App.tsx', content: 'export function App() { return null }' }],
      }),
    })
  return {
    restore,
    files,
    commands,
    fail: (value: boolean) => {
      failInstall = value
    },
  }
}

describe('template source dependency restoration', () => {
  test('installs new manifest before marking the restored project ready', async () => {
    const f = fixture()
    expect((await f.restore()).status).toBe(200)
    expect(f.commands.some((command) => command === `cd ${APP} && bun install`)).toBe(true)
    expect([...f.files.keys()].some((path) => path === '/tmp/lovbase.owned')).toBe(true)
  })
  test('failed install returns an error without marking ready, and an identical restore retries', async () => {
    const f = fixture()
    f.fail(true)
    const failed = await f.restore()
    expect(failed.status).toBe(500)
    expect((await failed.json()).error).toContain('dependency install failed')
    expect([...f.files.keys()].some((path) => path === '/tmp/lovbase.owned')).toBe(false)
    f.fail(false)
    expect((await f.restore()).status).toBe(200)
    expect(f.commands.filter((command) => command.includes('bun install'))).toHaveLength(2)
  })
  test('a source-only import does not reinstall dependencies', async () => {
    const f = fixture()
    expect((await f.restore(false)).status).toBe(200)
    expect(f.commands.some((command) => command.includes('bun install'))).toBe(false)
  })
})
