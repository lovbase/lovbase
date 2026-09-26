import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common'
import { Queue, QueueEvents } from 'bullmq'
import type { RedisOptions } from 'bullmq'
import Redis from 'ioredis'
import { ConfigService } from '../../config/config.service'
import { JobRepository } from './job.repository'

export const TURN_QUEUE = 'turns'
export const MAINTENANCE_QUEUE = 'maintenance'
export const QUEUE_PREFIX = 'lb:q'
export const CANCEL_CHANNEL = 'lb:q:cancel'
export type ContainerReleaseData = { appId: string; generation: number; expectedSourceVersion: number }

export function bullConnection(url: string, blocking = false): RedisOptions {
  const parsed = new URL(url)
  const db = parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number.isFinite(db) ? db : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    enableOfflineQueue: blocking,
    maxRetriesPerRequest: blocking ? null : 1,
    connectTimeout: 1500,
    retryStrategy: blocking ? undefined : () => null,
  }
}

@Injectable()
export class JobQueueService implements OnApplicationShutdown {
  private readonly log = new Logger('job-queue')
  private readonly command: Redis
  readonly turns: Queue
  readonly maintenance: Queue
  readonly events: QueueEvents

  constructor(private readonly cfg: ConfigService, private readonly jobs: JobRepository) {
    const quick = {
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
      connectTimeout: 1500, commandTimeout: 3000, retryStrategy: () => null,
    } as const
    this.command = new Redis(cfg.env.REDIS_URL, quick)
    this.command.on('error', () => {})
    this.turns = new Queue(TURN_QUEUE, { connection: bullConnection(cfg.env.REDIS_URL), prefix: QUEUE_PREFIX })
    this.maintenance = new Queue(MAINTENANCE_QUEUE, { connection: bullConnection(cfg.env.REDIS_URL), prefix: QUEUE_PREFIX })
    this.events = new QueueEvents(TURN_QUEUE, { connection: bullConnection(cfg.env.REDIS_URL, true), prefix: QUEUE_PREFIX })
    this.events.on('failed', ({ jobId, failedReason }) => this.log.error(`job ${jobId} failed: ${failedReason}`))
  }

  async enqueue(jobId: string): Promise<boolean> {
    try {
      await this.turns.add('turn.execute', { jobId }, {
        jobId, attempts: 1, removeOnComplete: 1000, removeOnFail: 5000,
      })
      await this.jobs.markEnqueued(jobId)
      return true
    } catch (error) {
      this.log.warn(`enqueue ${jobId} deferred: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  async reconcile(): Promise<number> {
    const pending = await this.jobs.unenqueued()
    let sent = 0
    for (const job of pending) if (await this.enqueue(job.id)) sent++
    return sent
  }

  async cancel(jobId: string) {
    try {
      const job = await this.turns.getJob(jobId)
      if (job && ['waiting', 'delayed', 'prioritized'].includes(await job.getState())) await job.remove()
    } catch (error) {
      this.log.warn(`could not remove queued job ${jobId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    try { await this.command.publish(CANCEL_CHANNEL, jobId) } catch { /* database polling is authoritative */ }
  }

  releaseJobId(appId: string, generation: number) { return `release-${appId}-${generation}` }

  async scheduleRelease(data: ContainerReleaseData, warmUntil: number) {
    const jobId = this.releaseJobId(data.appId, data.generation)
    const existing = await this.maintenance.getJob(jobId)
    if (existing) {
      const state = await existing.getState()
      if (state === 'delayed') {
        await existing.changeDelay(Math.max(0, warmUntil - Date.now()))
        return
      }
      if (['completed', 'failed'].includes(state)) await existing.remove().catch(() => {})
      else return
    }
    await this.maintenance.add('container.release', data, {
      jobId, delay: Math.max(0, warmUntil - Date.now()), attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: true, removeOnFail: 100,
    })
  }

  async cancelRelease(appId: string, generation: number) {
    const job = await this.maintenance.getJob(this.releaseJobId(appId, generation))
    if (job && ['delayed', 'waiting'].includes(await job.getState())) await job.remove().catch(() => {})
  }

  async onApplicationShutdown() {
    await Promise.allSettled([this.events.close(), this.turns.close(), this.maintenance.close()])
    this.command.disconnect()
  }
}
