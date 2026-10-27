import 'reflect-metadata'
import { expect, test } from 'bun:test'
import { plugin } from 'bun'
import { readFileSync } from 'node:fs'
import { verifySnapshotHost } from '@lovbase/sandbox/snapshot-auth'

const transpiler = new Bun.Transpiler({ loader: 'ts', tsconfig: { compilerOptions: { experimentalDecorators: true } } })
plugin({ name: 'snapshot-controller-decorators', setup(build) {
  build.onLoad({ filter: /\/snapshot\.controller\.ts$/ }, args => ({ contents: transpiler.transformSync(readFileSync(args.path, 'utf8')), loader: 'js' }))
} })
const { SnapshotController } = await import('../src/modules/storage/snapshot.controller')

test('snapshot entry authorizes ownership and redirects executable content off the authenticated origin', async () => {
  let authorized = false
  let mayRead = true
  let redirected = ''
  let status = 200
  const headers = new Map<string, string>()
  const controller = new SnapshotController({ async requireProject(_headers: Headers, project: string) {
    if (!mayRead) throw new Error('Not found')
    expect(project).toBe('project1')
    authorized = true
  } } as any, { findById: async () => ({ project_id: 'project1' }) } as any,
  { get: async () => { throw new Error('Must never serve application bytes from main origin') } } as any,
  { snapshotsConfigured: true, env: { SANDBOX_INTERNAL_TOKEN: 'test-only', BETTER_AUTH_URL: 'https://platform.example' },
    appUrl: (label: string) => `https://${label}.apps.example` } as any)
  const response = { status(code: number) { status = code; return this }, send() {},
    setHeader(key: string, value: string) { headers.set(key, value) },
    redirect(code: number, url: string) { status = code; redirected = url } } as any
  const req = { params: { appId: 'b123456789ab' }, headers: {}, path: '/api/snap/b123456789ab/game/index.html',
    originalUrl: '/api/snap/b123456789ab/game/index.html?mode=public&room=test' } as any
  await controller.file(req, response)
  expect(authorized).toBe(true)
  expect(status).toBe(302)
  const target = new URL(redirected)
  expect(target.origin).not.toBe('https://platform.example')
  expect(await verifySnapshotHost(target.hostname.split('.')[0], 'test-only')).toBe('b123456789ab')
  expect(target.pathname).toBe(req.path)
  expect(target.searchParams.get('room')).toBe('test')
  expect(headers.get('Cache-Control')).toBe('no-store')
  expect(headers.get('Referrer-Policy')).toBe('no-referrer')
  mayRead = false
  redirected = ''
  await controller.file(req, response)
  expect(status).toBe(404)
  expect(redirected).toBe('')
})
