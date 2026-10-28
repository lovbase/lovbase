import 'reflect-metadata'
import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { plugin } from 'bun'
import { readFileSync } from 'node:fs'
import type { LovbaseEvent } from '../src/common/events.service'
import type { JobRow } from '../src/modules/jobs/job.types'
import { publishState } from '../src/modules/jobs/publish-state'

// Match Nest's legacy decorators when Bun tests run from the workspace root.
const transpiler = new Bun.Transpiler({ loader: 'ts', tsconfig: { compilerOptions: { experimentalDecorators: true } } })
plugin({ name: 'publish-events-decorators', setup(build) {
  build.onLoad({ filter: /\/common\/events\.controller\.ts$/ }, args => ({ contents: transpiler.transformSync(readFileSync(args.path, 'utf8')), loader: 'js' }))
} })
const { EventsController } = await import('../src/common/events.controller')

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const row = (status: JobRow['status'] = 'running') => ({
  id: 'publish-1', app_id: 'app', project_id: 'project', created_at: new Date(1000),
  status, error: null, result: { files: 72 }, input: { operation: 'publish' },
} as JobRow)

function fixture() {
  let current: JobRow | null = row()
  let read: () => Promise<JobRow | null> = async () => current
  let listener: ((event: LovbaseEvent) => void) | undefined
  let reads = 0, unsubscribed = 0
  const topics: string[][] = []
  const access = {
    requireUser: async () => ({ user: { id: 'user' } }),
    requireApp: async (_headers: unknown, projectId: string, appId: string) => {
      if (projectId !== 'project' || appId !== 'app') throw Error('not found')
      return { app: { id: appId } }
    },
  }
  const unused = new Proxy({}, { get() { throw Error('publish stream must not load chat or sandbox') } })
  const controller = new EventsController(access as any, {
    subscribe: (next: string[], fn: typeof listener) => {
      topics.push(next); listener = fn
      return () => { listener = undefined; unsubscribed++ }
    },
  } as any, { latestPublish: async (appId: string) => { expect(appId).toBe('app'); reads++; return read() } } as any,
  unused as any, unused as any)
  const connect = () => {
    const req = Object.assign(new EventEmitter(), { headers: {} })
    const chunks: string[] = []
    const res = Object.assign(new EventEmitter(), {
      code: 0, writableEnded: false, headers: {} as Record<string, string>,
      status(code: number) { this.code = code; return this },
      set(headers: Record<string, string>) { this.headers = headers; return this },
      write(chunk: string) { chunks.push(chunk); return true },
      send(chunk: string) { chunks.push(chunk); return this },
      end() { this.writableEnded = true; this.emit('close') },
    })
    return { req, res, chunks, close: () => res.emit('close'),
      start: (projectId = 'project', appId = 'app') => controller.stream(req as any, res as any, 'publish', projectId, appId),
      snapshots: () => chunks.filter(c => c.startsWith('event: snapshot')).map(c => JSON.parse(c.split('data: ')[1]!)),
    }
  }
  return { connect, access, topics, set: (value: JobRow | null) => { current = value },
    setRead: (fn: typeof read) => { read = fn }, reads: () => reads, unsubscribed: () => unsubscribed,
    emit: (type = 'snapshot', payload: unknown = { jobId: 'publish-1', operation: 'publish' }) =>
      listener?.({ topic: 'app:app', type, payload }),
  }
}

test('publish SSE sends only a scoped durable snapshot, then success and failure updates', async () => {
  const f = fixture(), stream = f.connect()
  try {
    await stream.start()
    expect(stream.res.code).toBe(200)
    expect(stream.res.headers['Content-Type']).toBe('text/event-stream')
    expect(f.topics).toEqual([['app:app']])
    expect(stream.snapshots()).toEqual([{ task: publishState(row()) }])
    f.emit('activity', { jsonl: 'ignore' })
    f.emit('snapshot', { jobId: 'other', operation: 'build' })
    await tick()
    expect(f.reads()).toBe(1)
    f.set(row('succeeded')); f.emit(); await tick()
    expect(stream.snapshots().at(-1)?.task).toMatchObject({ status: 'succeeded', files: 72, createdAt: 1000 })
    f.set({ ...row('failed'), id: 'publish-2', error: 'Build failed' }); f.emit(); await tick()
    expect(stream.snapshots().at(-1)?.task).toMatchObject({ id: 'publish-2', status: 'failed', error: 'Build failed' })
  } finally { stream.close() }
  expect(f.unsubscribed()).toBe(1)
})

test('first visit can have no publication; reconnect recovers completion missed while disconnected', async () => {
  const f = fixture(), first = f.connect()
  f.set(null)
  await first.start()
  expect(first.snapshots()).toEqual([{ task: null }])
  first.close()
  f.set(row('succeeded')); f.emit(); await tick()
  expect(f.reads()).toBe(1)
  const reopened = f.connect()
  try {
    await reopened.start()
    expect(reopened.snapshots()).toEqual([{ task: publishState(row('succeeded')) }])
    // Legacy workers do not yet include operation on the event hint.
    f.emit('snapshot', { jobId: 'publish-1' }); await tick()
    expect(f.reads()).toBe(3)
  } finally { reopened.close() }
})

test('events during initial hydration are not lost, and slower reads cannot overwrite newer events', async () => {
  const f = fixture(), stream = f.connect()
  let release!: (value: JobRow) => void
  f.setRead(() => new Promise(resolve => { release = resolve }))
  const opened = stream.start()
  await tick()
  f.emit()
  f.setRead(async () => row('succeeded'))
  release(row('running'))
  try {
    await opened; await tick()
    expect(stream.snapshots().at(-1)?.task.status).toBe('succeeded')
    f.setRead(() => new Promise(resolve => { release = resolve }))
    f.emit()
    f.setRead(async () => row('failed')); f.emit(); await tick()
    release(row('running')); await tick()
    expect(stream.snapshots().at(-1)?.task.status).toBe('failed')
  } finally { stream.close() }
})

test('publish SSE enforces user, project and app access before subscribing or reading', async () => {
  const f = fixture()
  for (const [projectId, appId, status] of [['', 'app', 400], ['project', '', 400], ['other', 'app', 404], ['project', 'other', 404]] as const) {
    const stream = f.connect()
    await stream.start(projectId, appId)
    expect(stream.res.code).toBe(status)
  }
  f.access.requireUser = async () => { throw Error('signed out') }
  const stream = f.connect(); await stream.start()
  expect(stream.res.code).toBe(401)
  expect(f.topics).toEqual([])
  expect(f.reads()).toBe(0)
})

test('failed initial reads close the stream and release subscriptions for native reconnect', async () => {
  const f = fixture(), stream = f.connect()
  f.setRead(async () => { throw Error('database unavailable') })
  await stream.start()
  expect(stream.res.writableEnded).toBe(true)
  expect(f.unsubscribed()).toBe(1)
})
