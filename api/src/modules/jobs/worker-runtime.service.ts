import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common'
import { Worker, type Job } from 'bullmq'
import Redis from 'ioredis'
import os from 'node:os'
import { ConfigService } from '../../config/config.service'
import { AppsService } from '../apps/apps.service'
import { RatesService } from '../billing/rates.service'
import { LlmService } from '../llm/llm.service'
import { ProjectsService } from '../projects/projects.service'
import { AttachmentsService } from '../storage/attachments.service'
import { SandboxService } from '../sandbox/sandbox.service'
import { SandboxLeaseService, type SandboxLease } from '../sandbox/sandbox-lease.service'
import { TurnService } from '../agent/turn.service'
import { AgentService } from '../agent/agent.service'
import { bullConnection, CANCEL_CHANNEL, JobQueueService, MAINTENANCE_QUEUE, QUEUE_PREFIX, TURN_QUEUE, type ContainerReleaseData } from './job-queue.service'
import { JobRepository } from './job.repository'

const CANCEL_POLL_MS = 2_000

@Injectable()
export class WorkerRuntimeService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('worker')
  private readonly workerId = `${os.hostname()}:${process.pid}`
  private readonly subscriber: Redis
  private turnsWorker?: Worker
  private maintenanceWorker?: Worker
  private readonly active = new Map<string, string>()

  constructor(
    private readonly cfg: ConfigService,
    private readonly jobs: JobRepository,
    private readonly queues: JobQueueService,
    private readonly turns: TurnService,
    private readonly projects: ProjectsService,
    private readonly apps: AppsService,
    private readonly llm: LlmService,
    private readonly rates: RatesService,
    private readonly attachments: AttachmentsService,
    private readonly leases: SandboxLeaseService,
    private readonly sandbox: SandboxService,
    private readonly agent: AgentService,
  ) {
    this.subscriber = new Redis(cfg.env.REDIS_URL, { maxRetriesPerRequest: null })
    this.subscriber.on('error', (error) => this.log.warn(`redis cancel connection: ${error.message}`))
  }

  async onModuleInit() {
    this.subscriber.on('message', (_channel, jobId) => {
      const projectId = this.active.get(jobId)
      if (projectId) this.turns.abort(projectId)
    })
    await this.subscriber.subscribe(CANCEL_CHANNEL)

    this.turnsWorker = new Worker(
      TURN_QUEUE,
      (job) => this.execute(job),
      { connection: bullConnection(this.cfg.env.REDIS_URL, true), prefix: QUEUE_PREFIX, concurrency: this.cfg.env.TURN_WORKER_CONCURRENCY },
    )
    this.turnsWorker.on('error', (error) => this.log.error(error.message))
    this.maintenanceWorker = new Worker(
      MAINTENANCE_QUEUE,
      async (job) => {
        if (job.name === 'jobs.reconcile') await this.queues.reconcile()
        if (job.name === 'container.reap') await this.reapLeases()
        if (job.name === 'container.release') await this.releaseWarm(job.data as ContainerReleaseData)
      },
      { connection: bullConnection(this.cfg.env.REDIS_URL, true), prefix: QUEUE_PREFIX, concurrency: 2 },
    )
    this.maintenanceWorker.on('error', (error) => this.log.error(error.message))
    await this.queues.maintenance.add('jobs.reconcile', {}, {
      jobId: 'jobs-reconcile', repeat: { every: 5_000 }, removeOnComplete: 10, removeOnFail: 100,
    })
    await this.queues.maintenance.add('container.reap', {}, {
      jobId: 'container-reap', repeat: { every: 15_000 }, removeOnComplete: 10, removeOnFail: 100,
    })
    await this.queues.reconcile()
    this.log.log(`ready as ${this.workerId}, concurrency ${this.cfg.env.TURN_WORKER_CONCURRENCY}`)
  }

  private async execute(job: Job<{ jobId: string }>) {
    const row = await this.jobs.claim(job.data.jobId, this.workerId)
    if (!row) {
      await this.jobs.interruptRedelivery(job.data.jobId, this.workerId)
      return
    }
    this.active.set(row.id, row.project_id)
    let modelStarted = false
    let lease: SandboxLease | null = null
    let leaseLost = false
    let cancelPoll: ReturnType<typeof setInterval> | undefined
    let leaseRenewal: ReturnType<typeof setInterval> | undefined
    try {
      if (await this.jobs.cancelRequested(row.id)) {
        await this.jobs.finish(row.id, 'cancelled')
        return
      }
      const [project, app, cfg] = await Promise.all([
        this.projects.get(row.project_id),
        this.apps.get(row.project_id, row.app_id),
        this.llm.configFor(row.user_id, row.input.tier),
      ])
      if (!cfg) throw new Error('No model configured')
      await this.jobs.markWaitingCapacity(row.id, this.workerId)
      while (!lease) {
        if (await this.jobs.cancelRequested(row.id)) {
          await this.jobs.finish(row.id, 'cancelled')
          return
        }
        lease = await this.leases.acquire(row.app_id, row.id, new Date(row.created_at).getTime())
        if (lease) {
          await this.sandbox.claimLease(lease.appId, lease.generation)
          await this.queues.cancelRelease(lease.appId, lease.generation)
        }
        else await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      const [forModel, pricer] = await Promise.all([
        this.attachments.rehydrate(row.input.messages),
        this.rates.pricerFor(cfg.model, cfg.tier),
      ])
      if (!await this.jobs.markRunning(row.id, this.workerId)) {
        await this.jobs.finish(row.id, 'cancelled')
        return
      }
      modelStarted = true
      leaseRenewal = setInterval(() => {
        if (!lease) return
        void this.leases.renew(lease).then((renewed) => {
          if (renewed) return
          leaseLost = true
          this.turns.abort(row.project_id)
        }).catch(() => { /* the next renewal or lease TTL decides ownership */ })
      }, this.cfg.env.SANDBOX_LEASE_RENEW_SECONDS * 1000)
      leaseRenewal.unref?.()
      cancelPoll = setInterval(() => {
        void this.jobs.cancelRequested(row.id).then((cancel) => {
          if (cancel) this.turns.abort(row.project_id)
        })
      }, CANCEL_POLL_MS)
      cancelPoll.unref?.()
      const live = await this.turns.start({
        runId: row.run_id, project, app, userId: row.user_id, cfg,
        stored: row.input.messages, forModel, pricer, byok: cfg.source === 'user',
      })
      await live.done
      if (leaseLost) {
        await this.jobs.finish(row.id, 'interrupted', 'Sandbox lease was lost')
        return
      }
      if (await this.jobs.cancelRequested(row.id)) await this.jobs.finish(row.id, 'cancelled')
      else if (live.error) await this.jobs.finish(row.id, 'failed', String(live.error))
      else {
        if (live.touched) {
          await this.jobs.markFinalizing(row.id, this.workerId)
          await this.agent.finishBuild(project, row.app_id)
        }
        await this.jobs.finish(row.id, 'succeeded')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.jobs.finish(row.id, modelStarted ? 'interrupted' : 'failed', message)
      await this.turns.abort(row.project_id)
      throw error
    } finally {
      if (cancelPoll) clearInterval(cancelPoll)
      if (leaseRenewal) clearInterval(leaseRenewal)
      if (lease) {
        const warmUntil = Date.now() + this.cfg.env.CONTAINER_WARM_GRACE_SECONDS * 1000
        const warmed = modelStarted && !leaseLost && await this.leases.markWarm(lease, warmUntil).catch(() => false)
        if (warmed) {
          const { sourceVersion } = await this.apps.versions(row.app_id)
          await this.queues.scheduleRelease({ appId: row.app_id, generation: lease.generation, expectedSourceVersion: sourceVersion }, warmUntil)
        } else if (await this.leases.beginRelease(lease).catch(() => false)) {
          const stopped = await this.sandbox.stop(row.app_id).then(() => true).catch((error) => {
            this.log.warn(`stop ${row.app_id}: ${String(error)}`); return false
          })
          if (stopped) {
            await this.leases.release(lease).catch((error) => this.log.warn(`release ${row.app_id}: ${String(error)}`))
            this.sandbox.clearLease(row.app_id, lease.generation)
          }
        }
      }
      this.active.delete(row.id)
    }
  }

  private async reapLeases() {
    for (const lease of await this.leases.stale()) {
      if (!await this.leases.claimStale(lease)) continue
      let stopped = false
      try {
        await this.sandbox.claimLease(lease.appId, lease.generation)
        await this.sandbox.stop(lease.appId)
        stopped = true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('stale sandbox generation')) {
          const released = await this.leases.forceRelease(lease).catch(() => false)
          this.sandbox.clearLease(lease.appId, lease.generation)
          if (released) this.log.warn(`released stale generation ${lease.generation} from slot ${lease.slotId} for ${lease.appId}`)
        } else {
          this.log.warn(`reap stop ${lease.appId}: ${String(error)}`)
        }
      }
      if (!stopped) continue
      await this.leases.forceRelease(lease)
      this.sandbox.clearLease(lease.appId, lease.generation)
      this.log.warn(`reaped expired slot ${lease.slotId} for ${lease.appId} generation ${lease.generation}`)
    }
  }

  private async releaseWarm(data: ContainerReleaseData) {
    const lease = await this.leases.beginWarmRelease(data.appId, data.generation)
    if (!lease) return
    await this.sandbox.claimLease(data.appId, data.generation)
    const app = await this.apps.findById(data.appId)
    if (app) {
      const project = await this.projects.get(app.project_id)
      let versions = await this.apps.versions(app.id)
      for (let attempt = 0; attempt < 3 && versions.snapshotVersion < versions.sourceVersion; attempt++) {
        await this.agent.finishBuild(project, app.id)
        versions = await this.apps.versions(app.id)
        if (versions.snapshotVersion < versions.sourceVersion)
          await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1_000))
      }
      const finalized = await this.apps.findById(app.id)
      if (versions.snapshotVersion < versions.sourceVersion) await this.apps.markRuntime(app.id, 'snapshot_failed')
      else if (finalized?.snap_at) await this.apps.markRuntime(app.id, 'snapshot')
      else await this.apps.markRuntime(app.id, 'cold')
    }
    const stopped = await this.sandbox.stop(data.appId).then(() => true).catch((error) => {
      this.log.warn(`release stop ${data.appId}: ${String(error)}`); return false
    })
    if (!stopped) throw new Error(`Could not stop sandbox ${data.appId}`)
    await this.leases.release(lease)
    this.sandbox.clearLease(data.appId, data.generation)
  }

  async onApplicationShutdown() {
    await Promise.allSettled([
      this.turnsWorker?.close(),
      this.maintenanceWorker?.close(),
    ])
    this.subscriber.disconnect()
  }
}
