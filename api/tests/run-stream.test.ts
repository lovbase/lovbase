import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import Redis from 'ioredis'
import { ConfigService } from '../src/config/config.service'
import { RunChunkStore } from '../src/modules/projects/run-chunk.store'
import { RunStreamService } from '../src/modules/projects/run-stream.service'

const redisBinary = Bun.which('redis-server')
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const key = (id: string) => `lb:run:{${id}}:chunks`
const id = () => crypto.randomUUID()

// A fresh, non-persistent Redis process: never touch a developer's or production database.
describe.skipIf(!redisBinary)('Redis run recordings', () => {
  let process: ChildProcess
  let admin: Redis
  let url: string
  const stores: RunChunkStore[] = []
  const makeStore = (env: Record<string, string> = {}) => {
    const store = new RunChunkStore(ConfigService.of({ REDIS_URL: url, ...env }))
    stores.push(store)
    return store
  }
  beforeAll(async () => {
    const socket = createServer()
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve))
    const port = (socket.address() as { port: number }).port
    await new Promise<void>((resolve) => socket.close(() => resolve()))
    url = `redis://127.0.0.1:${port}`
    process = spawn(redisBinary!, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => {
      process.once('error', reject)
      process.once('exit', (code) => reject(new Error(`test Redis exited: ${code}`)))
      process.stdout!.on('data', (data) => { if (String(data).includes('Ready to accept connections')) resolve() })
    })
    admin = new Redis(url, { lazyConnect: true, retryStrategy: () => null })
    await admin.connect()
  })
  afterAll(async () => {
    for (const store of stores) store.close()
    admin?.disconnect()
    if (process && process.exitCode === null) {
      const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()))
      process.kill('SIGTERM')
      await exited
    }
  })

  test('atomic expiry, idempotent retry, sequence validation, and end marker', async () => {
    const store = makeStore()
    const run = id()
    await store.begin(run)
    await store.append(run, 0, '中文')
    await store.append(run, 0, '中文')
    expect(await admin.xlen(key(run))).toBe(2)
    await expect(store.append(run, 0, 'different')).rejects.toThrow('conflicting')
    await expect(store.append(run, 2, 'gap')).rejects.toThrow('sequence gap')
    await admin.expire(key(run), 10)
    await store.touch(run)
    expect(await admin.ttl(key(run))).toBeGreaterThan(7100)
    await admin.expire(key(run), 10)
    await store.finish(run, 1)
    expect(await admin.ttl(key(run))).toBeGreaterThan(7100)
    await expect(store.append(run, 2, 'late')).rejects.toThrow('already ended')
    const rows = await admin.xrange(key(run), '-', '+')
    expect(rows.map((r) => r[0])).toEqual(['1-0', '2-0', '3-0'])
    expect(rows[1][1]).toContain('6') // UTF-8 byte count, not JS string length.
  })

  test('two API instances both replay history and receive the complete live tail', async () => {
    const writer = makeStore()
    const run = id()
    await writer.begin(run)
    await writer.append(run, 0, 'history\n')
    const a = await new RunStreamService(makeStore()).replay(run, async () => true)
    const b = await new RunStreamService(makeStore()).replay(run, async () => true)
    const outputs = Promise.all([new Response(a).text(), new Response(b).text()])
    await writer.append(run, 1, 'tail\n')
    await writer.finish(run, 2)
    expect(await outputs).toEqual(['history\ntail\n', 'history\ntail\n'])
  })

  test('flushes during a quiet tool call, then flushes the final partial batch', async () => {
    const store = makeStore()
    const service = new RunStreamService(store)
    const run = id()
    let producer!: ReadableStreamDefaultController<string>
    const capture = service.capture(run, new ReadableStream({ start(c) { producer = c } }))
    producer.enqueue('first')
    await delay(400)
    expect(await admin.xlen(key(run))).toBe(2)
    producer.enqueue('last')
    producer.close()
    await capture
    const replay = await service.replay(run, async () => false)
    expect(await new Response(replay).text()).toBe('firstlast')
  })

  test('heartbeat renews the whole run even with no new chunks', async () => {
    const store = makeStore({ RUN_CHUNKS_TTL_SECONDS: '60' })
    const run = id()
    let producer!: ReadableStreamDefaultController<string>
    const capture = new RunStreamService(store).capture(run, new ReadableStream({ start(c) { producer = c } }))
    await delay(100)
    await admin.expire(key(run), 15)
    await delay(10_300)
    expect(await admin.ttl(key(run))).toBeGreaterThan(50)
    producer.close()
    await capture
  }, 15_000)

  test('expired recordings cannot be recreated from a partial tail', async () => {
    const store = makeStore()
    const run = id()
    await store.begin(run)
    await admin.pexpire(key(run), 1)
    await delay(20)
    expect(await new RunStreamService(store).replay(run, async () => true)).toBeNull()
    await expect(store.append(run, 0, 'tail')).rejects.toThrow('expired')
    expect(await admin.exists(key(run))).toBe(0)
  })

  test('size limit discards the recording while fully draining generation', async () => {
    const store = makeStore({ RUN_CHUNKS_MAX_BYTES: '8192' })
    const run = id()
    let generated = 0
    await new RunStreamService(store).capture(run, new ReadableStream({
      pull(c) { if (generated++ < 4) c.enqueue('x'.repeat(9000)); else c.close() },
    }))
    expect(generated).toBe(5)
    expect(await store.available(run)).toBe(false)
  })

  test('missing prefix falls back; a mid-stream gap emits a protocol error', async () => {
    const store = makeStore()
    const service = new RunStreamService(store)
    const run = id()
    await store.begin(run)
    await store.append(run, 0, 'first')
    await store.append(run, 1, 'second')
    await store.finish(run, 2)
    await admin.xdel(key(run), '2-0')
    expect(await new Response(await service.replay(run, async () => false)).text()).toContain('"type":"error"')
    await admin.xdel(key(run), '1-0')
    expect(await service.replay(run, async () => false)).toBeNull()
  })

  test('cancel releases a blocked reader and leaves the writer usable', async () => {
    const store = makeStore()
    const run = id()
    await store.begin(run)
    const stream = (await new RunStreamService(store).replay(run, async () => true))!
    const reader = stream.getReader()
    const pending = reader.read()
    await delay(30)
    await reader.cancel()
    expect((await pending).done).toBe(true)
    await store.append(run, 0, 'still generating')
    expect(await store.available(run)).toBe(true)
  })

  test('a dead writer without an end marker requests transcript recovery', async () => {
    const store = makeStore()
    const run = id()
    await store.begin(run)
    const stream = await new RunStreamService(store).replay(run, async () => false)
    expect(await new Response(stream).text()).toContain('"type":"error"')
  })

  test('drains the tail if the run closes between a read timeout and the status check', async () => {
    const store = makeStore()
    const run = id()
    await store.begin(run)
    const stream = await new RunStreamService(store).replay(run, async () => {
      await store.append(run, 0, 'last bytes')
      await store.finish(run, 1)
      return false
    })
    expect(await new Response(stream).text()).toBe('last bytes')
  })

  test('Redis connection failure does not reject capture or stop reading', async () => {
    const store = makeStore({ REDIS_URL: 'redis://127.0.0.1:1' })
    let read = 0
    const service = new RunStreamService(store)
    await service.capture(id(), new ReadableStream({
      pull(c) { if (read++ < 3) c.enqueue('chunk'); else c.close() },
    }))
    expect(read).toBe(4)
    expect(await service.replay(id(), async () => true)).toBeNull()
  })
})
