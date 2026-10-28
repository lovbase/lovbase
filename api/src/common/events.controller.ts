import { Controller, Get, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { requestHeaders } from './http'
import { Public } from './public.decorator'
import { AccessService } from '../modules/auth/access.service'
import { ConversationService } from '../modules/projects/conversation.service'
import { JobRepository } from '../modules/jobs/job.repository'
import { SandboxService } from '../modules/sandbox/sandbox.service'
import { parseActivity } from '../modules/agent/boris'
import { EventsService } from './events.service'
import { publishState, type PublishSnapshot } from '../modules/jobs/publish-state'

type Scope = 'project' | 'build' | 'notifications' | 'publish'

/** Authenticated, resumable browser state streams. Every reconnect receives a fresh snapshot. */
@Public()
@Controller('api/events')
export class EventsController {
  constructor(
    private readonly access: AccessService,
    private readonly events: EventsService,
    private readonly jobs: JobRepository,
    private readonly conversation: ConversationService,
    private readonly sandbox: SandboxService,
  ) {}

  private async projectSnapshot(projectId: string) {
    const [job, chat, live] = await Promise.all([
      this.jobs.stateForProject(projectId), this.conversation.getChat(projectId), this.conversation.liveRun(projectId),
    ])
    const running = !!job && ['queued', 'waiting_capacity', 'starting', 'running', 'finalizing', 'cancelling'].includes(job.status)
    return { chat, job, progress: live?.progress ?? null, running: running || !!live, startedAt: job?.startedAt ?? live?.startedAt ?? null }
  }

  private async publishSnapshot(appId: string): Promise<PublishSnapshot> {
    const job = await this.jobs.latestPublish(appId)
    return { task: job ? publishState(job) : null }
  }

  @Get()
  async stream(@Req() req: Request, @Res() res: Response, @Query('scope') rawScope?: string,
    @Query('projectId') projectId?: string, @Query('appId') appId?: string) {
    let user
    try { user = await this.access.requireUser(requestHeaders(req)) }
    catch { return void res.status(401).send('unauthorized') }

    const scope = (rawScope || (projectId ? 'project' : 'notifications')) as Scope
    if (!['project', 'build', 'notifications', 'publish'].includes(scope)) return void res.status(400).send('invalid scope')
    let project: Awaited<ReturnType<AccessService['requireProject']>> | undefined
    let app: Awaited<ReturnType<AccessService['requireApp']>> | undefined
    try {
      if (scope === 'build' || scope === 'publish') {
        if (!projectId || !appId) return void res.status(400).send('projectId and appId are required')
        app = await this.access.requireApp(requestHeaders(req), projectId, appId)
      } else if (scope === 'project') {
        if (!projectId) return void res.status(400).send('projectId is required')
        project = await this.access.requireProject(requestHeaders(req), projectId)
      }
    } catch { return void res.status(404).send('not found') }

    res.status(200).set({
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()
    let closed = false
    const send = (type: string, payload: unknown) => {
      if (closed || res.writableEnded) return
      res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    const topics = scope === 'notifications'
      ? [`user:${user.user.id}`]
      : scope === 'project'
        ? [`project:${project!.project.id}`]
        : [`app:${app!.app.id}`]
    let heartbeat: ReturnType<typeof setInterval>
    let ready = false
    let pending: import('./events.service').LovbaseEvent | null = null
    let sequence = 0
    const deliver = (event: import('./events.service').LovbaseEvent) => {
      const current = ++sequence
      if (scope === 'notifications') void this.jobs.notifications(user.user.id).then((items) => { if (current === sequence) send('notifications', items) }).catch(() => {})
      else if (scope === 'publish') void this.publishSnapshot(app!.app.id)
        .then(snapshot => { if (current === sequence) send('snapshot', snapshot) })
        .catch(() => { cleanup(); res.end() })
      else if (scope === 'build' && event.type === 'activity') send('activity', event.payload)
      else void this.projectSnapshot(project!.project.id).then((snapshot) => { if (current === sequence) send('snapshot', snapshot) }).catch(() => {})
    }
    const unsubscribe = this.events.subscribe(topics, (event) => {
      if (scope === 'publish') {
        const payload = event.payload as { jobId?: string; operation?: string } | null
        // Older workers omit operation; accept their job hints during a rolling update too.
        if (event.type !== 'snapshot' || !payload?.jobId || (payload.operation && payload.operation !== 'publish')) return
      }
      pending = event
      if (ready) deliver(event)
    })
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    heartbeat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n') }, 15_000)
    heartbeat.unref?.()
    send('ready', { scope })

    // Subscribe before reading the snapshot so a state transition cannot land between the two.
    if (scope === 'notifications') {
      send('notifications', await this.jobs.notifications(user.user.id))
    } else if (scope === 'project') {
      send('snapshot', await this.projectSnapshot(project!.project.id))
    } else if (scope === 'publish') {
      try { send('snapshot', await this.publishSnapshot(app!.app.id)) }
      catch { cleanup(); res.end(); return }
    } else {
      try {
        const activity = await this.sandbox.activity(app!.app.id, 0)
        send('activity', parseActivity(activity.jsonl))
      } catch { send('activity', { running: false, steps: [], text: '', code: '' }) }
    }
    ready = true
    if (pending) { const event = pending; pending = null; deliver(event) }
  }
}
