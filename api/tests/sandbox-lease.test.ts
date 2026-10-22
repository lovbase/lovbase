import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import Redis from 'ioredis'
import { ConfigService } from '../src/config/config.service'
import { SandboxLeaseService } from '../src/modules/sandbox/sandbox-lease.service'

const redisBinary = Bun.which('redis-server')
const appKey = (appId: string) => `lb:sandbox:{leases}:app:${appId}`
const slotsKey = 'lb:sandbox:{leases}:slots'
const generationKey = 'lb:sandbox:{leases}:generation'

describe.skipIf(!redisBinary)('sandbox slot leases', () => {
  let process: ChildProcess
  let admin: Redis
  let leases: SandboxLeaseService

  beforeAll(async () => {
    const socket = createServer()
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve))
    const port = (socket.address() as { port: number }).port
    await new Promise<void>((resolve) => socket.close(() => resolve()))
    const url = `redis://127.0.0.1:${port}`
    process = spawn(redisBinary!, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => {
      process.once('error', reject)
      process.once('exit', (code) => reject(new Error(`test Redis exited: ${code}`)))
      process.stdout!.on('data', (data) => { if (String(data).includes('Ready to accept connections')) resolve() })
    })
    admin = new Redis(url)
    leases = new SandboxLeaseService(ConfigService.of({
      REDIS_URL: url, SANDBOX_SLOT_COUNT: '1', SANDBOX_LEASE_TTL_SECONDS: '15',
      SANDBOX_LEASE_RENEW_SECONDS: '5', CONTAINER_WARM_GRACE_SECONDS: '10',
    }))
  })

  afterAll(async () => {
    await leases?.onApplicationShutdown()
    admin?.disconnect()
    if (process && process.exitCode === null) {
      const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()))
      process.kill('SIGTERM')
      await exited
    }
  })

  test('is FIFO, but lets the same app take over its warm slot', async () => {
    const first = (await leases.acquire('app-a', 'job-a', 1))!
    expect(first.slotId).toBe(1)
    expect(await leases.acquire('app-b', 'job-b', 2)).toBeNull()

    // A browser preview racing the queued turn must not allocate a second slot for the same app.
    expect(await leases.acquire('app-a', 'web-app-a', 3)).toBeNull()
    expect(await admin.hlen(slotsKey)).toBe(1)
    expect(await admin.hget(appKey('app-a'), 'ownerJobId')).toBe('job-a')
    expect(await leases.renew(first)).toBe(true)

    expect(await leases.markWarm(first, Date.now() + 10_000)).toBe(true)
    const reused = (await leases.acquire('app-a', 'job-a2', 3))!
    expect(reused.generation).toBe(first.generation)
    expect(await leases.release(first)).toBe(false)

    expect(await leases.beginRelease(reused)).toBe(true)
    expect(await leases.release(reused)).toBe(true)
    const second = await leases.acquire('app-b', 'job-b', 2)
    expect(second?.slotId).toBe(1)
    expect(second?.generation).toBeGreaterThan(first.generation)
  })

  test('expired ownership cannot renew and must be claimed before force release', async () => {
    await admin.flushdb()
    const lease = (await leases.acquire('app-c', 'job-c', 1))!
    const raw = JSON.parse((await admin.hget(slotsKey, '1'))!)
    raw.leaseUntil = 0
    await admin.hset(slotsKey, '1', JSON.stringify(raw))
    await admin.hset(appKey('app-c'), 'leaseUntil', '0')

    expect(await leases.renew(lease)).toBe(false)
    const [stale] = await leases.stale()
    expect(stale.generation).toBe(lease.generation)
    expect(await leases.claimStale(stale)).toBe(true)
    expect(await leases.forceRelease(stale)).toBe(true)
    expect(await admin.hlen(slotsKey)).toBe(0)
  })

  test('generation stays ahead of persisted sandboxes after the Redis counter resets', async () => {
    await admin.flushdb()
    await admin.set(generationKey, '1')
    const before = Date.now()

    const lease = (await leases.acquire('app-reset', 'job-reset', 1))!

    expect(lease.generation).toBeGreaterThanOrEqual(before)
    expect(Number(await admin.get(generationKey))).toBe(lease.generation)
  })

  test('reaper removes an orphaned old slot without touching the newer app lease', async () => {
    await admin.flushdb()
    const old = (await leases.acquire('app-orphan', 'job-old', 1))!
    const newer = { appId: 'app-orphan', jobId: 'web-app-orphan', generation: old.generation + 1, state: 'warm', leaseUntil: Date.now() + 60_000 }
    await admin.hset(slotsKey, '2', JSON.stringify(newer))
    await admin.hset(appKey('app-orphan'), {
      slotId: '2', ownerJobId: newer.jobId, generation: String(newer.generation),
      state: newer.state, leaseUntil: String(newer.leaseUntil), warmUntil: String(Date.now() + 10_000),
    })
    const staleRaw = JSON.parse((await admin.hget(slotsKey, String(old.slotId)))!)
    staleRaw.leaseUntil = 0
    await admin.hset(slotsKey, String(old.slotId), JSON.stringify(staleRaw))

    const [stale] = await leases.stale()
    expect(await leases.claimStale(stale)).toBe(false)
    expect(await admin.hget(slotsKey, String(old.slotId))).toBeNull()
    expect(await admin.hget(appKey('app-orphan'), 'generation')).toBe(String(newer.generation))
    expect(await admin.hget(slotsKey, '2')).not.toBeNull()
  })

  test('composer activity extends only a warm lease', async () => {
    await admin.flushdb()
    const lease = (await leases.acquire('app-d', 'job-d', 1))!
    expect(await leases.composerActivity('app-d')).toBeNull()
    await leases.markWarm(lease, Date.now() + 1_000)
    const activity = await leases.composerActivity('app-d')
    expect(activity?.generation).toBe(lease.generation)
    expect(activity!.warmUntil).toBeGreaterThan(Date.now() + 9_000)
  })
  test('Pro overtakes queued Free work; aged Free work retains its original FIFO position',async()=>{
    await admin.flushdb()
    const busy=(await leases.acquire('busy','busy',1,1))!
    expect(await leases.acquire('free','free',2,2)).toBeNull()
    expect(await leases.acquire('pro','pro',3,1)).toBeNull()
    await leases.beginRelease(busy);await leases.release(busy)
    expect(await leases.acquire('free','free',2,2)).toBeNull()
    const pro=(await leases.acquire('pro','pro',3,1))!
    expect(pro).not.toBeNull()
    await leases.beginRelease(pro);await leases.release(pro)
    // The caller promotes an old Free task using the same ten-minute policy as BullMQ.
    const aged=(await leases.acquire('free','free',2,1))!
    expect(aged).not.toBeNull()
    expect(await leases.acquire('new-pro','new-pro',4,1)).toBeNull()
    await leases.beginRelease(aged);await leases.release(aged)
    expect(await leases.acquire('new-pro','new-pro',4,1)).not.toBeNull()
  })

})

// BullMQ and container allocation share the same priority classes and original enqueue time.
describe.skipIf(!redisBinary)('BullMQ plan priority and aging', () => {
  let child: ChildProcess
  let queues: import('../src/modules/jobs/job-queue.service').JobQueueService
  const rows = new Map<string, any>()
  const plans = new Map<string, string>()
  beforeAll(async () => {
    const socket = createServer()
    await new Promise<void>(r => socket.listen(0,'127.0.0.1',r))
    const port = (socket.address() as {port:number}).port
    await new Promise<void>(r => socket.close(()=>r()))
    child = spawn(redisBinary!,['--bind','127.0.0.1','--port',String(port),'--save','','--appendonly','no'])
    await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.stdout!.on('data',d=>{if(String(d).includes('Ready to accept connections'))resolve()})})
    const {JobQueueService} = await import('../src/modules/jobs/job-queue.service')
    const {generationPriority} = await import('@lovbase/core/entitlements')
    queues = new JobQueueService(ConfigService.of({REDIS_URL:`redis://127.0.0.1:${port}`}), {
      get:async(id:string)=>rows.get(id), markEnqueued:async()=>{}, waiting:async()=>[...rows.values()],
      priorityFor:async(id:string)=>generationPriority(plans.get(id) ?? 'free',new Date(rows.get(id).created_at).getTime()),
    } as any)
  })
  afterAll(async()=>{await queues?.onApplicationShutdown();if(child && child.exitCode===null){const done=new Promise<void>(r=>child.once('exit',()=>r()));child.kill();await done}})
  test('Pro leads, an aged Free job moves ahead of newer Pro, and cancellation/requeue preserves order',async()=>{
    const now=Date.now()
    for(const [id,age,plan] of [['free-old',60_000,'free'],['pro-new',30_000,'pro'],['free-new',0,'free']] as const){
      rows.set(id,{id,created_at:new Date(now-age),input:{}});plans.set(id,plan)
      expect(await queues.enqueue(id)).toBe(true)
    }
    expect((await queues.turns.getPrioritized()).map(j=>j.id)).toEqual(['pro-new','free-old','free-new'])
    rows.get('free-old').created_at=new Date(now-11*60_000)
    await queues.refreshPriorities()
    expect((await queues.turns.getPrioritized()).map(j=>j.id)).toEqual(['free-old','pro-new','free-new'])
    plans.set('free-new','pro');await queues.refreshPriorities()
    expect((await queues.turns.getPrioritized()).map(j=>j.id)).toEqual(['free-old','pro-new','free-new'])
    await queues.cancel('pro-new');expect(await queues.turns.getJob('pro-new')).toBeUndefined()
    expect(await queues.enqueue('pro-new')).toBe(true)
    expect((await queues.turns.getPrioritized()).map(j=>j.id)).toEqual(['free-old','pro-new','free-new'])
    await queues.turns.obliterate({force:true})
  })
})
