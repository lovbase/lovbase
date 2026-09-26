import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { sandboxApi } from '../src/app'
import type { SandboxBackend, SandboxCtx } from '../src/backend'

function fixture() {
  const files = new Map<string, string>()
  let stopped = 0
  const backend: SandboxBackend = {
    async exec() { return { success: true, stdout: '', stderr: '' } },
    async exists(path) { return files.has(path) },
    async readFile(path) { const value = files.get(path); if (value === undefined) throw new Error('missing'); return value },
    async writeFile(path, content) { files.set(path, content) },
    async listFiles() { return [] },
    async preview() { return { previewUrl: 'http://preview.test' } },
    async logs() { return { running: false } },
    async stop() { stopped++ },
    async destroy() {},
  }
  const ctx: SandboxCtx = {
    token: 'test-token',
    config: { apiUrl: 'http://api.test', publicApiUrl: 'http://api.test' },
    backend: () => backend,
  }
  const app = new Hono<{ Variables: { sandbox: SandboxCtx } }>()
    .use('*', async (c, next) => { c.set('sandbox', ctx); await next() })
    .route('/', sandboxApi)
  const request = (path: string, init: RequestInit = {}) => app.request(path, {
    ...init,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', ...init.headers },
  })
  return { request, stopped: () => stopped }
}

describe('sandbox generation fencing', () => {
  test('rejects an old worker after a newer generation has claimed the container', async () => {
    const { request, stopped } = fixture()
    expect((await request('/apps/app/lease', { method: 'POST', body: JSON.stringify({ generation: 2 }) })).status).toBe(200)
    expect((await request('/apps/app/stop', { method: 'POST', headers: { 'x-lovbase-generation': '1' } })).status).toBe(409)
    expect(stopped()).toBe(0)
    expect((await request('/apps/app/stop', { method: 'POST', headers: { 'x-lovbase-generation': '2' } })).status).toBe(200)
    expect(stopped()).toBe(1)
  })

  test('does not let a lower generation reclaim the container', async () => {
    const { request } = fixture()
    await request('/apps/app/lease', { method: 'POST', body: JSON.stringify({ generation: 3 }) })
    expect((await request('/apps/app/lease', { method: 'POST', body: JSON.stringify({ generation: 2 }) })).status).toBe(409)
  })
})
