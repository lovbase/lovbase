import { Injectable, Logger } from '@nestjs/common'
import { hc, type ClientResponse } from 'hono/client'
import type { SandboxApi } from '@lovbase/sandbox/api'
import { ConfigService } from '../../config/config.service'

// Client for the sandbox service (sandbox/): the Cloudflare Worker in production, the Docker
// runner locally and self-hosted. Typed straight from the service's Hono routes, so a route change
// there fails to compile here. Internal token auth; never exposed to browsers.

/** The 200 body of a route; error statuses become thrown Errors in `ok()` below. */
type Ok<R> = R extends ClientResponse<infer B, infer S, 'json'> ? (200 extends S ? B : never) : never

/**
 * How long one build may run before it is stopped. Past this the agent is killed rather than left
 * running: a detached straggler is what the next turn ends up racing.
 *
 * Everything that decides whether a run is still alive has to allow at least this long, or a task
 * inside its budget gets written off as a process that died — see `RUN_STALE_AFTER`.
 */
export const RUN_BUDGET_MS = 30 * 60_000
/**
 * How long one poll parks inside the sandbox service. Comfortably inside undici's 300s
 * header timeout, which is what a single blocking call used to die on.
 */
const POLL_WAIT_MS = 60_000

export type AppFile = { path: string; content: string }
export type RunBody = {
  workspaceId: string; apiToken: string; prompt: string
  llm: { baseUrl: string; apiKey: string; model: string }
}

@Injectable()
export class SandboxService {
  private readonly log = new Logger('sandbox')
  private readonly generations = new Map<string, number>()

  constructor(private readonly cfg: ConfigService) {}

  get configured() { return this.cfg.sandboxConfigured }

  private api(appId?: string) {
    const generation = appId ? this.generations.get(appId) : undefined
    const client = hc<SandboxApi>(this.cfg.sandboxUrl, {
      headers: {
        Authorization: `Bearer ${this.cfg.env.SANDBOX_INTERNAL_TOKEN}`,
        ...(generation ? { 'X-Lovbase-Generation': String(generation) } : {}),
      },
    })
    return client.apps[':id']
  }

  async claimLease(appId: string, generation: number) {
    const client = this.api(appId)
    await this.ok(client.lease.$post({ param: { id: appId }, json: { generation } }))
    this.generations.set(appId, generation)
  }

  clearLease(appId: string, generation: number) {
    if (this.generations.get(appId) === generation) this.generations.delete(appId)
  }

  private async ok<R extends ClientResponse<unknown, number, 'json'>>(p: Promise<R>): Promise<Ok<R>> {
    const r = await p
    let body: any = null
    try { body = await r.json() } catch { /* auth middleware answers in plain text */ }
    if (!r.ok) throw new Error(body?.error ?? `sandbox HTTP ${r.status}`)
    return body
  }

  /**
   * One Boris turn: start it, then poll in windows.
   *
   * The whole turn used to be a single `fetch` held open for its duration — which Node's undici
   * abandons after 300 seconds, so any build over five minutes failed as `fetch failed` having
   * wasted all five, and the agent retried on top of an agent that was still running. Every
   * request here is short; `RUN_BUDGET_MS` is the only real deadline.
   */
  async run(appId: string, body: RunBody) {
    const startedAt = Date.now()
    const { runId } = await this.ok(this.api(appId).run.$post({ param: { id: appId }, json: body }))
    while (Date.now() - startedAt < RUN_BUDGET_MS) {
      const r = await this.ok(this.api(appId).run.poll.$post({
        param: { id: appId }, json: { runId, waitMs: POLL_WAIT_MS },
      }))
      if (r.done) return { ...r, duration: Date.now() - startedAt }
    }
    // Nothing else will stop it: the agent is detached inside the container.
    await this.stopRun(appId).catch(() => { /* best effort; the next run kills stragglers anyway */ })
    throw new Error(`The build ran for more than ${Math.round(RUN_BUDGET_MS / 60_000)} minutes and was stopped`)
  }
  stopRun(appId: string) { return this.ok(this.api(appId).run.stop.$post({ param: { id: appId } })) }
  preview(appId: string, body: { workspaceId: string; apiToken: string }) {
    return this.ok(this.api(appId).preview.$post({ param: { id: appId }, json: body }))
  }
  publish(appId: string, slug: string) { return this.ok(this.api(appId).publish.$post({ param: { id: appId }, json: { slug } })) }
  /** Build the app and keep the result, so reopening it later needs no container. */
  snapshotBuild(appId: string) { return this.ok(this.api(appId).snapshot.$post({ param: { id: appId } })) }

  /**
   * A PNG of a published app. Not under `/apps/:id` and not JSON, so it does not go through the
   * typed client: the thing being photographed is the copy in object storage, which outlives the
   * container, and asking for a container would wake one to photograph what it is not serving.
   */
  async thumb(url: string): Promise<Uint8Array | null> {
    const res = await fetch(new URL('/thumb', this.cfg.sandboxUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.env.SANDBOX_INTERNAL_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    // 501 is the self-hosted runner saying it has no browser. That is a configuration, not a fault.
    if (res.status === 501) return null
    if (!res.ok) throw new Error(`cover HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }
  unpublish(appId: string, slug: string) { return this.ok(this.api(appId).unpublish.$post({ param: { id: appId }, json: { slug } })) }
  /** Give the container's slot back. Keeps the source and the built copy — see `/apps/:id/stop`. */
  stop(appId: string) { return this.ok(this.api(appId).stop.$post({ param: { id: appId } })) }
  /** For an app being deleted: the container *and* everything that outlives it. */
  destroy(appId: string) { return this.ok(this.api(appId).destroy.$post({ param: { id: appId } })) }
  build(appId: string) { return this.ok(this.api(appId).build.$post({ param: { id: appId } })) }
  /** One allowlisted command in the app directory; the Worker decides what is allowed. */
  exec(appId: string, command: string) { return this.ok(this.api(appId).exec.$post({ param: { id: appId }, json: { command } })) }
  /** The agent's event stream from `from` bytes in; the reply's `next` is the following call's `from`. */
  activity(appId: string, from = 0) {
    return this.ok(this.api(appId).activity.$get({ param: { id: appId }, query: { from: String(from) } }))
  }
  logs(appId: string) { return this.ok(this.api(appId).logs.$get({ param: { id: appId } })) }
  state(appId: string) { return this.ok(this.api(appId).state.$get({ param: { id: appId } })) }
  exportFiles(appId: string) { return this.ok(this.api(appId).export.$get({ param: { id: appId } })) }
  importFiles(appId: string, files: AppFile[]) { return this.ok(this.api(appId).import.$post({ param: { id: appId }, json: { files } })) }
  files(appId: string) { return this.ok(this.api(appId).files.$get({ param: { id: appId } })) }
  readFile(appId: string, path: string) { return this.ok(this.api(appId).file.$get({ param: { id: appId }, query: { path } })) }
  writeFile(appId: string, path: string, content: string) {
    return this.ok(this.api(appId).file.$put({ param: { id: appId }, query: { path }, json: { content } }))
  }

  /**
   * Containers are ephemeral: the filesystem goes away when one is evicted, and the next request
   * would otherwise get a blank template. Call this before anything that needs the app's source.
   */
  async restoreIfFresh(appId: string, load: () => Promise<AppFile[] | null>) {
    try {
      const { fresh } = await this.state(appId)
      if (!fresh) return false
      const files = await load()
      if (!files?.length) return false
      await this.importFiles(appId, files)
      return true
    } catch (err) {
      this.log.error(`restore failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** Mirror the sandbox's current source into durable storage. Never throws into the caller. */
  async snapshot(appId: string, save: (files: AppFile[]) => Promise<void>) {
    try {
      const { files } = await this.exportFiles(appId)
      if (files.length) await save(files)
    } catch (err) {
      this.log.error(`snapshot failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Everything a deleted app leaves behind: the published copy in object storage and the
   * container holding its source. Best effort — a failure here must not block the delete, or a
   * user is stuck with an app they cannot remove.
   */
  async reclaim(appId: string, slug: string | null) {
    if (slug) {
      try { await this.unpublish(appId, slug) } catch (err) { this.log.error(`unpublish failed: ${String(err)}`) }
    }
    try { await this.destroy(appId) } catch (err) { this.log.error(`destroy failed: ${String(err)}`) }
  }
}
