import { Injectable, Logger } from '@nestjs/common'
import { hc, type ClientResponse } from 'hono/client'
import type { SandboxApi } from '@lovbase/sandbox/api'
import { ConfigService } from '../../config/config.service'

// Client for the sandbox service (sandbox/): the Cloudflare Worker in production, the Docker
// runner locally and self-hosted. Typed straight from the service's Hono routes, so a route change
// there fails to compile here. Internal token auth; never exposed to browsers.

/** The 200 body of a route; error statuses become thrown Errors in `ok()` below. */
type Ok<R> = R extends ClientResponse<infer B, infer S, 'json'> ? (200 extends S ? B : never) : never

export type AppFile = { path: string; content: string }
export type RunBody = {
  workspaceId: string; apiToken: string; prompt: string
  llm: { baseUrl: string; apiKey: string; model: string }
}

@Injectable()
export class SandboxService {
  private readonly log = new Logger('sandbox')

  constructor(private readonly cfg: ConfigService) {}

  get configured() { return this.cfg.sandboxConfigured }

  private api() {
    const client = hc<SandboxApi>(this.cfg.sandboxUrl, {
      headers: { Authorization: `Bearer ${this.cfg.env.SANDBOX_INTERNAL_TOKEN}` },
    })
    return client.apps[':id']
  }

  private async ok<R extends ClientResponse<unknown, number, 'json'>>(p: Promise<R>): Promise<Ok<R>> {
    const r = await p
    let body: any = null
    try { body = await r.json() } catch { /* auth middleware answers in plain text */ }
    if (!r.ok) throw new Error(body?.error ?? `sandbox HTTP ${r.status}`)
    return body
  }

  run(appId: string, body: RunBody) { return this.ok(this.api().run.$post({ param: { id: appId }, json: body })) }
  preview(appId: string, body: { workspaceId: string; apiToken: string }) {
    return this.ok(this.api().preview.$post({ param: { id: appId }, json: body }))
  }
  publish(appId: string, slug: string) { return this.ok(this.api().publish.$post({ param: { id: appId }, json: { slug } })) }

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
  unpublish(appId: string, slug: string) { return this.ok(this.api().unpublish.$post({ param: { id: appId }, json: { slug } })) }
  destroy(appId: string) { return this.ok(this.api().destroy.$post({ param: { id: appId } })) }
  build(appId: string) { return this.ok(this.api().build.$post({ param: { id: appId } })) }
  activity(appId: string) { return this.ok(this.api().activity.$get({ param: { id: appId } })) }
  logs(appId: string) { return this.ok(this.api().logs.$get({ param: { id: appId } })) }
  state(appId: string) { return this.ok(this.api().state.$get({ param: { id: appId } })) }
  exportFiles(appId: string) { return this.ok(this.api().export.$get({ param: { id: appId } })) }
  importFiles(appId: string, files: AppFile[]) { return this.ok(this.api().import.$post({ param: { id: appId }, json: { files } })) }
  files(appId: string) { return this.ok(this.api().files.$get({ param: { id: appId } })) }
  readFile(appId: string, path: string) { return this.ok(this.api().file.$get({ param: { id: appId }, query: { path } })) }
  writeFile(appId: string, path: string, content: string) {
    return this.ok(this.api().file.$put({ param: { id: appId }, query: { path }, json: { content } }))
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
