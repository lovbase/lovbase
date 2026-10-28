import { StorageReconciler } from '../storage/storage-reconciler.service'
import { GenerationService } from '../agent/generation.service'
import { DirectDatabaseService } from '../entitlements/direct-database.service'
import { AppOperationsService } from '../development/app-operations.service'
import { ConversationService } from '../projects/conversation.service'
import { AccountsService } from '../accounts/accounts.service'
import { SheetImportsService } from '../integrations/sheet-imports.service'
import { ComposioService } from '../integrations/composio.service'
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common'
import { Worker, type Job } from 'bullmq'
import Redis from 'ioredis'
import os from 'node:os'
import { ConfigService } from '../../config/config.service'
import { AppsService } from '../apps/apps.service'
import { RatesService } from '../billing/rates.service'
import { BillingService } from '../billing/billing.service'
import { RefundsService } from '../billing/refunds.service'
import { LlmService } from '../llm/llm.service'
import { ProjectsService } from '../projects/projects.service'
import { AttachmentsService } from '../storage/attachments.service'
import { SandboxService } from '../sandbox/sandbox.service'
import { SandboxLeaseService, type SandboxLease } from '../sandbox/sandbox-lease.service'
import { TurnService, type LiveTurn } from '../agent/turn.service'
import { AgentService } from '../agent/agent.service'
import { bullConnection, APP_OPERATION_QUEUE, CANCEL_CHANNEL, JobQueueService, MAINTENANCE_QUEUE, QUEUE_PREFIX, TURN_QUEUE, type ContainerReleaseData } from './job-queue.service'
import { JobRepository } from './job.repository'
import type { JobRow, TurnRecovery } from './job.types'
import { isOutOfCredits } from '../credits/credits.service'

const CANCEL_POLL_MS = 2_000

@Injectable()
export class WorkerRuntimeService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('worker')
  private readonly workerId = `${os.hostname()}:${process.pid}`
  private readonly subscriber: Redis
  private operationsWorker?: Worker
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
    private readonly conversation: ConversationService,
    private readonly operations: AppOperationsService,
    private readonly accounts: AccountsService,
    private readonly sheetImports: SheetImportsService,
    private readonly composio: ComposioService,
    private readonly direct: DirectDatabaseService,
    private readonly generation: GenerationService,
    private readonly storageReconciler: StorageReconciler,
    private readonly billing: BillingService,
    private readonly refunds: RefundsService,
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
    this.operationsWorker = new Worker(
      APP_OPERATION_QUEUE, (job) => this.execute(job),
      { connection: bullConnection(this.cfg.env.REDIS_URL, true), prefix: QUEUE_PREFIX, concurrency: this.cfg.env.TURN_WORKER_CONCURRENCY },
    )
    this.operationsWorker.on('error', (error) => this.log.error(error.message))
    this.turnsWorker.on('error', (error) => this.log.error(error.message))
    this.maintenanceWorker = new Worker(
      MAINTENANCE_QUEUE,
      async (job) => {
        if (job.name === 'jobs.reconcile') await this.queues.reconcile()
        if (job.name === 'billing.refunds') await this.refunds.retry()
        if (job.name === 'entitlements.reconcile') {
          await this.refunds.retry()
          await this.billing.retrySync()
          await this.direct.reconcile()
          await this.generation.reconcile()
          await this.composio.reconcileUsage()
          await this.queues.refreshPriorities()
        }
        if (job.name === 'storage.reconcile') await this.storageReconciler.reconcile()
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
    await this.queues.maintenance.add('storage.reconcile', {}, {jobId:'storage-reconcile',repeat:{every:300_000},removeOnComplete:5,removeOnFail:20})
    await this.storageReconciler.reconcile().catch(error=>this.log.error(`Initial storage inventory failed; retry scheduled: ${error instanceof Error ? error.message : String(error)}`))
    await this.queues.maintenance.add('entitlements.reconcile', {}, {
      jobId:'entitlements-reconcile',repeat:{every:60_000},removeOnComplete:10,removeOnFail:100,
    })
    await this.direct.reconcile()
    await this.refunds.retry()
    await this.queues.refreshPriorities()
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
    let liveTurn: LiveTurn | undefined
    let cancelPoll: ReturnType<typeof setInterval> | undefined
    let leaseRenewal: ReturnType<typeof setInterval> | undefined
    try {
      if (await this.jobs.cancelRequested(row.id)) {
        await this.jobs.finish(row.id, 'cancelled')
        return
      }
      let [project, app, cfg] = await Promise.all([
        this.projects.get(row.project_id),
        this.apps.get(row.project_id, row.app_id),
        row.input.operation ? null : this.llm.configFor(row.user_id, row.input.tier),
      ])
      if (project.owner_id !== row.user_id) throw new Error('Project not found')
      if (!cfg && !row.input.operation) throw new Error('No model configured')
      if (row.input.importId) {
        await this.sheetImports.execute(row.user_id, row.project_id, row.app_id, row.input.importId, row.id)
        Object.assign(project, await this.projects.get(row.project_id))
      }
      await this.jobs.markWaitingCapacity(row.id, this.workerId)
      while (!lease) {
        if (await this.jobs.cancelRequested(row.id)) {
          await this.jobs.finish(row.id, 'cancelled')
          return
        }
        lease = await this.leases.acquire(row.app_id, row.id, new Date(row.created_at).getTime(), await this.jobs.priorityFor(row.id))
        if (lease) {
          await this.sandbox.claimLease(lease.appId, lease.generation)
          await this.queues.cancelRelease(lease.appId, lease.generation)
        }
        else await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      if (row.input.operation) {
        if (!await this.jobs.markRunning(row.id, this.workerId)) {
          await this.jobs.finish(row.id, 'cancelled'); return
        }
        modelStarted = true // Keep the successfully used sandbox warm; no model is invoked.
        leaseRenewal = setInterval(() => {
          if (lease) void this.leases.renew(lease).then(ok => { if (!ok) leaseLost = true }).catch(() => { leaseLost = true })
        }, this.cfg.env.SANDBOX_LEASE_RENEW_SECONDS * 1000)
        leaseRenewal.unref?.()
        const user = await this.accounts.identity(row.user_id)
        if (!user) throw new Error('Account not found')
        const result = await this.operations.perform({ user, project, app }, row.input.operation)
        if (leaseLost) throw new Error('Sandbox lease lost; inspect application before retrying')
        await this.jobs.finish(row.id, 'succeeded', undefined, result)
        return
      }
      cfg=await this.llm.configFor(row.user_id,row.input.tier)
      if (!cfg) throw new Error('No model configured')
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
      liveTurn = live
      await live.done
      if (leaseLost) {
        await this.jobs.finish(row.id, 'interrupted', 'Sandbox lease was lost')
        return
      }
      if (live.outOfCredits || await this.jobs.creditExhausted(row.run_id)) {
        await this.finishCreditExhaustion(row, live.touched, live.chatSaved !== false)
      }
      else if (await this.jobs.cancelRequested(row.id)) await this.jobs.finish(row.id, 'cancelled')
      else if (live.error) await this.jobs.finish(row.id, 'failed', String(live.error))
      else {
        if (live.touched) {
          await this.jobs.markFinalizing(row.id, this.workerId)
          await this.agent.finishBuild(project, row.app_id)
        }
        await this.jobs.finish(row.id, 'succeeded', undefined, {
          appGenerated: live.touched,
          ...(row.input.fingerprint ? { messages: await this.conversation.getChat(row.project_id) } : {}),
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isOutOfCredits(error) || await this.jobs.creditExhausted(row.run_id)) {
        await this.finishCreditExhaustion(row, liveTurn?.touched ?? false, liveTurn?.chatSaved !== false)
        return
      }
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

  private async finishCreditExhaustion(row: JobRow, touched: boolean, chatSaved: boolean) {
    const startedAt = Date.now()
    const app = await this.apps.get(row.project_id, row.app_id)
    const recovery: TurnRecovery = {
      terminationReason: 'out_of_credits', sourceStatus: 'saving',
      finalizingStartedAt: startedAt, hadPreview: !!app.snap_at,
    }
    await this.jobs.markFinalizing(row.id, this.workerId)
    await this.jobs.updateRecovery(row.id, recovery)
    try {
      let chatError: unknown = chatSaved ? null : new Error('Conversation could not be saved')
      try { await this.conversation.sealChat(row.project_id, 'out_of_credits') }
      catch (error) { chatError = error }
      // A transcript failure must never prevent a separate attempt to make the code durable.
      if (touched) await this.sandbox.snapshot(row.app_id, files => this.apps.saveSnapshot(row.app_id, files))
      if (chatError) throw chatError
      recovery.sourceStatus = 'saved'
      const versions = await this.apps.versions(row.app_id)
      recovery.sourceVersion = versions.sourceVersion
      this.log.log(`credits recovery ${row.id}: source saved in ${Date.now() - startedAt}ms`)
      if (!touched || versions.snapshotVersion >= versions.sourceVersion || !this.cfg.snapshotsConfigured) {
        recovery.previewStatus = versions.snapshotVersion >= versions.sourceVersion && app.snap_at ? 'ready' : 'unchanged'
      } else {
        recovery.previewStatus = 'saving'
        recovery.previewStartedAt = Date.now()
        await this.jobs.updateRecovery(row.id, recovery)
        try {
          const result = await this.sandbox.snapshotBuild(row.app_id, 30_000)
          if (result.ok) {
            await this.apps.markSnapshotted(row.app_id, versions.sourceVersion)
            recovery.previewStatus = 'ready'
          } else {
            recovery.previewStatus = 'timedOut' in result && result.timedOut ? 'timed_out' : 'failed'
            if ('cleanupFailed' in result && result.cleanupFailed) {
              recovery.hadPreview = false // A failed rollback cannot promise a usable old preview.
              await this.apps.markRuntime(row.app_id, 'snapshot_failed')
            }
          }
        } catch (error) {
          recovery.previewStatus = 'failed'
          this.log.warn(`credits recovery ${row.id}: preview failed: ${String(error)}`)
        }
      }
    } catch (error) {
      recovery.sourceStatus = 'failed'
      this.log.error(`credits recovery ${row.id}: source save failed: ${String(error)}`)
    }
    await this.jobs.finish(row.id, 'interrupted', 'out_of_credits', recovery)
    this.log.log(`credits recovery ${row.id}: finished in ${Date.now() - startedAt}ms, preview=${recovery.previewStatus ?? 'skipped'}`)
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
      const latest = await this.jobs.stateForProject(app.project_id)
      const exhausted = latest?.recovery?.terminationReason === 'out_of_credits'
        && (latest.recovery.sourceStatus === 'failed' || latest.recovery.sourceVersion === versions.sourceVersion)
      for (let attempt = 0; attempt < (exhausted ? 0 : 3) && versions.snapshotVersion < versions.sourceVersion; attempt++) {
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
      this.operationsWorker?.close(),
      this.maintenanceWorker?.close(),
    ])
    this.subscriber.disconnect()
  }
}
