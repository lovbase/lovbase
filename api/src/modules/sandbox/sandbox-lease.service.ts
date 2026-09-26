import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common'
import Redis from 'ioredis'
import { ConfigService } from '../../config/config.service'

const SLOTS = 'lb:sandbox:{leases}:slots'
const WAITING = 'lb:sandbox:{leases}:waiting'
const GENERATION = 'lb:sandbox:{leases}:generation'
const appKey = (appId: string) => `lb:sandbox:{leases}:app:${appId}`
const keepaliveKey = (appId: string) => `lb:sandbox:keepalive:${appId}`
const composerKey = (appId: string) => `lb:composer:${appId}`

const ACQUIRE = `
local current = redis.call('HGETALL', KEYS[2])
if #current > 0 then
  local lease = {}
  for i = 1, #current, 2 do lease[current[i]] = current[i + 1] end
  if (lease.state == 'warm' or (lease.state == 'busy' and lease.ownerJobId == ARGV[2])) and tonumber(lease.leaseUntil) > tonumber(ARGV[3]) then
    local untilAt = tonumber(ARGV[3]) + tonumber(ARGV[4])
    redis.call('HSET', KEYS[2], 'ownerJobId', ARGV[2], 'state', 'busy', 'leaseUntil', untilAt)
    redis.call('HSET', KEYS[1], lease.slotId, cjson.encode({appId=ARGV[1], jobId=ARGV[2], generation=lease.generation, state='busy', leaseUntil=untilAt}))
    redis.call('ZREM', KEYS[3], ARGV[2])
    return {'acquired', lease.slotId, lease.generation}
  end
  -- One app maps to one container and therefore one lease. A competing Web preview must wait for
  -- the active job instead of allocating another slot and overwriting this app ownership record.
  return {'waiting'}
end
redis.call('ZADD', KEYS[3], 'NX', ARGV[5], ARGV[2])
local first = redis.call('ZRANGE', KEYS[3], 0, 0)
if #first == 0 or first[1] ~= ARGV[2] then return {'waiting'} end
for i = 1, tonumber(ARGV[6]) do
  local slot = tostring(i)
  if not redis.call('HGET', KEYS[1], slot) then
    local generation = redis.call('INCR', KEYS[4])
    local now = tonumber(ARGV[3])
    if generation < now then
      generation = now
      redis.call('SET', KEYS[4], string.format('%.0f', generation))
    end
    local untilAt = tonumber(ARGV[3]) + tonumber(ARGV[4])
    redis.call('HSET', KEYS[2], 'slotId', slot, 'ownerJobId', ARGV[2], 'generation', generation, 'state', 'busy', 'leaseUntil', untilAt, 'warmUntil', 0)
    redis.call('HSET', KEYS[1], slot, cjson.encode({appId=ARGV[1], jobId=ARGV[2], generation=generation, state='busy', leaseUntil=untilAt}))
    redis.call('ZREM', KEYS[3], ARGV[2])
    return {'acquired', slot, tostring(generation)}
  end
end
return {'waiting'}
`

const RENEW = `
local owner = redis.call('HGET', KEYS[2], 'ownerJobId')
local generation = redis.call('HGET', KEYS[2], 'generation')
local slot = redis.call('HGET', KEYS[2], 'slotId')
local oldUntil = redis.call('HGET', KEYS[2], 'leaseUntil')
if owner ~= ARGV[2] or generation ~= ARGV[3] or not slot or tonumber(oldUntil) <= tonumber(ARGV[4]) then return 0 end
local untilAt = tonumber(ARGV[4]) + tonumber(ARGV[5])
local state = redis.call('HGET', KEYS[2], 'state') or 'busy'
redis.call('HSET', KEYS[2], 'leaseUntil', untilAt)
redis.call('HSET', KEYS[1], slot, cjson.encode({appId=ARGV[1], jobId=ARGV[2], generation=generation, state=state, leaseUntil=untilAt}))
return 1
`

const RELEASE = `
local owner = redis.call('HGET', KEYS[2], 'ownerJobId')
local generation = redis.call('HGET', KEYS[2], 'generation')
local slot = redis.call('HGET', KEYS[2], 'slotId')
if owner ~= ARGV[2] or generation ~= ARGV[3] or not slot then return 0 end
redis.call('HDEL', KEYS[1], slot)
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[2])
return 1
`

const FORCE_RELEASE = `
local generation = redis.call('HGET', KEYS[2], 'generation')
local slot = redis.call('HGET', KEYS[2], 'slotId')
if generation ~= ARGV[2] or not slot then return 0 end
redis.call('HDEL', KEYS[1], slot)
redis.call('DEL', KEYS[2])
return 1
`

const CLAIM_STALE = `
local generation = redis.call('HGET', KEYS[2], 'generation')
local leaseUntil = redis.call('HGET', KEYS[2], 'leaseUntil')
local slot = redis.call('HGET', KEYS[2], 'slotId')
local owner = redis.call('HGET', KEYS[2], 'ownerJobId')
if generation ~= ARGV[2] or slot ~= ARGV[5] then
  -- Repair duplicate slots written by older acquire logic. Only delete the exact stale generation;
  -- the app hash and its newer container ownership must remain untouched.
  local raw = redis.call('HGET', KEYS[1], ARGV[5])
  if raw then
    local saved = cjson.decode(raw)
    if saved.appId == ARGV[1] and tostring(saved.generation) == ARGV[2] then
      redis.call('HDEL', KEYS[1], ARGV[5])
    end
  end
  return 0
end
if not slot or tonumber(leaseUntil) > tonumber(ARGV[3]) then return 0 end
local untilAt = tonumber(ARGV[3]) + tonumber(ARGV[4])
redis.call('HSET', KEYS[2], 'state', 'releasing', 'leaseUntil', untilAt)
redis.call('HSET', KEYS[1], slot, cjson.encode({appId=ARGV[1], jobId=owner, generation=generation, state='releasing', leaseUntil=untilAt}))
return 1
`

const BEGIN_RELEASE = `
local owner = redis.call('HGET', KEYS[2], 'ownerJobId')
local generation = redis.call('HGET', KEYS[2], 'generation')
local slot = redis.call('HGET', KEYS[2], 'slotId')
if owner ~= ARGV[2] or generation ~= ARGV[3] or not slot then return 0 end
local untilAt = tonumber(ARGV[4]) + tonumber(ARGV[5])
redis.call('HSET', KEYS[2], 'state', 'releasing', 'leaseUntil', untilAt)
redis.call('HSET', KEYS[1], slot, cjson.encode({appId=ARGV[1], jobId=ARGV[2], generation=generation, state='releasing', leaseUntil=untilAt}))
return 1
`

const MARK_WARM = `
local owner = redis.call('HGET', KEYS[2], 'ownerJobId')
local generation = redis.call('HGET', KEYS[2], 'generation')
local slot = redis.call('HGET', KEYS[2], 'slotId')
if owner ~= ARGV[2] or generation ~= ARGV[3] or not slot then return 0 end
local leaseUntil = tonumber(ARGV[4]) + tonumber(ARGV[5])
redis.call('HSET', KEYS[2], 'state', 'warm', 'warmUntil', ARGV[4], 'leaseUntil', leaseUntil)
redis.call('HSET', KEYS[1], slot, cjson.encode({appId=ARGV[1], jobId=ARGV[2], generation=generation, state='warm', leaseUntil=leaseUntil}))
return 1
`

const BEGIN_WARM_RELEASE = `
local state = redis.call('HGET', KEYS[2], 'state')
local generation = redis.call('HGET', KEYS[2], 'generation')
local warmUntil = redis.call('HGET', KEYS[2], 'warmUntil')
local slot = redis.call('HGET', KEYS[2], 'slotId')
local owner = redis.call('HGET', KEYS[2], 'ownerJobId')
if state ~= 'warm' or generation ~= ARGV[2] or not slot or tonumber(warmUntil) > tonumber(ARGV[3]) then return {} end
local leaseUntil = tonumber(ARGV[3]) + tonumber(ARGV[4])
redis.call('HSET', KEYS[2], 'state', 'releasing', 'leaseUntil', leaseUntil)
redis.call('HSET', KEYS[1], slot, cjson.encode({appId=ARGV[1], jobId=owner, generation=generation, state='releasing', leaseUntil=leaseUntil}))
return {slot, owner}
`

const COMPOSER_ACTIVITY = `
local state = redis.call('HGET', KEYS[2], 'state')
local generation = redis.call('HGET', KEYS[2], 'generation')
local slot = redis.call('HGET', KEYS[2], 'slotId')
local owner = redis.call('HGET', KEYS[2], 'ownerJobId')
if state ~= 'warm' or not generation or not slot then return {} end
local warmUntil = tonumber(ARGV[2]) + tonumber(ARGV[3])
local leaseUntil = warmUntil + tonumber(ARGV[4])
redis.call('HSET', KEYS[2], 'warmUntil', warmUntil, 'leaseUntil', leaseUntil, 'lastComposerActivityAt', ARGV[2])
redis.call('HSET', KEYS[1], slot, cjson.encode({appId=ARGV[1], jobId=owner, generation=generation, state='warm', leaseUntil=leaseUntil}))
return {generation, tostring(warmUntil)}
`

const REMOVE_APP = `
local slot = redis.call('HGET', KEYS[2], 'slotId')
local owner = redis.call('HGET', KEYS[2], 'ownerJobId')
if slot then redis.call('HDEL', KEYS[1], slot) end
if owner then redis.call('ZREM', KEYS[3], owner) end
redis.call('DEL', KEYS[2])
return slot or ''
`

export type SandboxLease = { appId: string; jobId: string; slotId: number; generation: number }
export type StaleSandboxLease = SandboxLease & { state: string; leaseUntil: number }
export type ComposerLeaseActivity = { generation: number; warmUntil: number; keepalive: boolean }

@Injectable()
export class SandboxLeaseService implements OnApplicationShutdown {
  private readonly log = new Logger('sandbox-leases')
  private readonly redis: Redis

  constructor(private readonly cfg: ConfigService) {
    this.redis = new Redis(cfg.env.REDIS_URL, { maxRetriesPerRequest: 2 })
    this.redis.on('error', (error) => this.log.warn(error.message))
  }

  async acquire(appId: string, jobId: string, createdAt: number): Promise<SandboxLease | null> {
    const now = Date.now()
    const result = await this.redis.eval(
      ACQUIRE, 4, SLOTS, appKey(appId), WAITING, GENERATION,
      appId, jobId, now, this.cfg.env.SANDBOX_LEASE_TTL_SECONDS * 1000,
      createdAt, this.cfg.env.SANDBOX_SLOT_COUNT,
    ) as string[]
    if (result[0] !== 'acquired') return null
    return { appId, jobId, slotId: Number(result[1]), generation: Number(result[2]) }
  }

  async renew(lease: SandboxLease): Promise<boolean> {
    const result = await this.redis.eval(
      RENEW, 2, SLOTS, appKey(lease.appId), lease.appId, lease.jobId, lease.generation,
      Date.now(), this.cfg.env.SANDBOX_LEASE_TTL_SECONDS * 1000,
    )
    return result === 1
  }

  async release(lease: SandboxLease): Promise<boolean> {
    const result = await this.redis.eval(
      RELEASE, 3, SLOTS, appKey(lease.appId), WAITING,
      lease.appId, lease.jobId, lease.generation,
    )
    return result === 1
  }

  async beginRelease(lease: SandboxLease): Promise<boolean> {
    const result = await this.redis.eval(
      BEGIN_RELEASE, 2, SLOTS, appKey(lease.appId), lease.appId, lease.jobId, lease.generation,
      Date.now(), this.cfg.env.SANDBOX_LEASE_TTL_SECONDS * 1000,
    )
    return result === 1
  }

  async markWarm(lease: SandboxLease, warmUntil: number): Promise<boolean> {
    const result = await this.redis.eval(
      MARK_WARM, 2, SLOTS, appKey(lease.appId), lease.appId, lease.jobId, lease.generation,
      warmUntil, this.cfg.env.SANDBOX_LEASE_TTL_SECONDS * 1000,
    )
    return result === 1
  }

  async beginWarmRelease(appId: string, generation: number): Promise<SandboxLease | null> {
    const result = await this.redis.eval(
      BEGIN_WARM_RELEASE, 2, SLOTS, appKey(appId), appId, generation, Date.now(),
      this.cfg.env.SANDBOX_LEASE_TTL_SECONDS * 1000,
    ) as string[]
    if (!result.length) return null
    return { appId, generation, slotId: Number(result[0]), jobId: result[1] }
  }

  async composerActivity(appId: string): Promise<ComposerLeaseActivity | null> {
    const now = Date.now()
    await this.redis.set(composerKey(appId), String(now), 'EX', this.cfg.env.CONTAINER_WARM_GRACE_SECONDS + 60)
    const result = await this.redis.eval(
      COMPOSER_ACTIVITY, 2, SLOTS, appKey(appId), appId, now,
      this.cfg.env.CONTAINER_WARM_GRACE_SECONDS * 1000,
      this.cfg.env.SANDBOX_LEASE_TTL_SECONDS * 1000,
    ) as string[]
    if (!result.length) return null
    const keepalive = await this.redis.set(keepaliveKey(appId), String(now), 'PX', 30_000, 'NX') === 'OK'
    return { generation: Number(result[0]), warmUntil: Number(result[1]), keepalive }
  }

  async removeApp(appId: string) {
    await this.redis.eval(REMOVE_APP, 3, SLOTS, appKey(appId), WAITING)
    await this.redis.del(composerKey(appId), keepaliveKey(appId))
  }

  async stale(): Promise<StaleSandboxLease[]> {
    const entries = await this.redis.hgetall(SLOTS)
    const now = Date.now()
    return Object.entries(entries).flatMap(([slotId, raw]) => {
      try {
        const value = JSON.parse(raw) as { appId: string; jobId: string; generation: number; state: string; leaseUntil: number }
        return value.leaseUntil <= now
          ? [{ ...value, slotId: Number(slotId) }]
          : []
      } catch { return [] }
    })
  }

  async forceRelease(lease: StaleSandboxLease): Promise<boolean> {
    const result = await this.redis.eval(
      FORCE_RELEASE, 2, SLOTS, appKey(lease.appId), lease.appId, lease.generation,
    )
    return result === 1
  }

  async claimStale(lease: StaleSandboxLease): Promise<boolean> {
    const result = await this.redis.eval(
      CLAIM_STALE, 2, SLOTS, appKey(lease.appId), lease.appId, lease.generation,
      Date.now(), this.cfg.env.SANDBOX_LEASE_TTL_SECONDS * 1000, lease.slotId,
    )
    return result === 1
  }

  async onApplicationShutdown() { this.redis.disconnect() }
}
