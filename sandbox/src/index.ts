// Cloudflare host for the sandbox API: one Sandbox container per app (Durable Object), previews
// proxied straight into the container, published apps served from R2. The API itself is in app.ts.
import { Hono } from 'hono'
import { Sandbox, getSandbox, proxyToSandbox } from '@cloudflare/sandbox'
import { SNAP, notFound, onError, sandboxApi } from './app'
import puppeteer from '@cloudflare/puppeteer'
import { mimeFor, shq, type SandboxBackend, type SandboxCtx, type StaticStore } from './backend'
export { Sandbox }

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>
  LOVBASE_API_URL: string
  LOVBASE_PUBLIC_API_URL: string
  SANDBOX_HTTP_PROXY?: string
  SANDBOX_SLEEP_AFTER?: string
  INTERNAL_TOKEN: string
  /** Static hosting for published apps. Absent in local dev, where publishing is simply unavailable. */
  APPS?: R2Bucket
  /** Browser Rendering, for a published app's cover. Absent locally; covers fall back to the wireframe. */
  BROWSER?: Fetcher
}

const APP = '/workspace/app'

const app = new Hono<{ Bindings: Env; Variables: { sandbox: SandboxCtx } }>()
  // Preview traffic for exposed ports (e.g. 5173-<id>-<token>.<host>) is routed here first.
  .use('*', async (c, next) => (await proxyToSandbox(c.req.raw, c.env)) ?? next())
  // A published app is served from R2 at <slug>.<zone>. Anything that is not the apex (the
  // token-protected API) and not a live preview is treated as a publish slug.
  .use('*', async (c, next) => {
    const url = new URL(c.req.url)
    const isApex = url.hostname.split('.').length <= 2
    if (isApex || !c.env.APPS) return next()
    return (await serveStatic(c.env.APPS, url.hostname.split('.')[0]!, url.pathname)) ?? next()
  })
  .use('*', async (c, next) => {
    const env = c.env
    c.set('sandbox', {
      token: env.INTERNAL_TOKEN,
      config: { apiUrl: env.LOVBASE_API_URL, publicApiUrl: env.LOVBASE_PUBLIC_API_URL, httpProxy: env.SANDBOX_HTTP_PROXY || undefined },
      store: env.APPS && r2Store(env.APPS),
      shoot: env.BROWSER && ((url) => screenshot(env.BROWSER!, url)),
      // Idle containers are the one cost that runs away on its own: every build leaves one warm.
      // Anything actually working renews this through its own requests — a build execs into its
      // container every two seconds — so the window only has to outlast the gaps in real work.
      backend: (appId, hostname) => cloudflareBackend(getSandbox(env.Sandbox, appId, { sleepAfter: env.SANDBOX_SLEEP_AFTER || '30s' }), hostname),
    })
    await next()
  })
  .route('/', sandboxApi)
  .notFound(notFound)
  .onError(onError)

export default app

/**
 * One card-sized PNG of a published app.
 *
 * A wide viewport at deviceScaleFactor 2 and a small clip: the card shows this at about 380px, and
 * a full-page shot of a scrolling app is mostly whitespace once it is that small. `networkidle0`
 * rather than `load`, because these apps fetch their rows before there is anything worth
 * photographing, and the browser is closed in a finally — a leaked one bills until it times out.
 */
async function screenshot(browser: Fetcher, url: string): Promise<ArrayBuffer> {
  const b = await puppeteer.launch(browser)
  try {
    const page = await b.newPage()
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 20_000 })
    const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1280, height: 800 } })
    return shot instanceof Uint8Array ? (shot.buffer as ArrayBuffer) : shot
  } finally {
    await b.close().catch(() => {})
  }
}

function cloudflareBackend(sb: Sandbox, hostname: string): SandboxBackend {
  return {
    async exec(script, o) {
      const r = await sb.exec(`sh -lc ${shq(script)}`, { cwd: o?.cwd, env: o?.env, timeout: o?.timeoutMs })
      return { success: r.success, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    exists: async (p) => (await sb.exists(p)).exists,
    readFile: async (p) => (await sb.readFile(p)).content,
    async writeFile(p, content) {
      const dir = p.slice(0, p.lastIndexOf('/'))
      if (dir) await sb.mkdir(dir, { recursive: true })
      await sb.writeFile(p, content)
    },
    async listFiles(dir) {
      const r = await sb.listFiles(dir, { recursive: true, includeHidden: true })
      return r.files.filter((f) => f.type === 'file').map((f) => ({ path: f.relativePath, size: f.size }))
    },
    /** Make sure `vite dev` is up, then hand back the preview URL. */
    async preview() {
      const procs = await sb.listProcesses()
      let dev = procs.find((p) => p.id === 'vite' && p.status === 'running')
      if (!dev) {
        dev = await sb.startProcess('bun run dev', { cwd: APP, processId: 'vite' })
        await dev.waitForPort(5173, { timeout: 60_000 })
      }
      const { url } = await sb.exposePort(5173, { hostname, name: 'vite' })
      return { previewUrl: url }
    },
    async logs() {
      const p = await sb.getProcess('vite')
      if (!p) return { running: false }
      const l = await sb.getProcessLogs('vite')
      return { running: p.status === 'running', stdout: l.stdout.slice(-4000), stderr: l.stderr.slice(-4000) }
    },
    setEnv: (vars) => sb.setEnvVars(vars),
    /** Best effort: a container that is already gone must not turn a stop into an error. */
    async stop() {
      try { await (sb as unknown as { stop(): Promise<void> }).stop() } catch { /* already stopped */ }
    },
    /**
     * Clear the project *and* release the container instance.
     *
     * Dropping the directory and leaving the container to sleep out on its own looks equivalent
     * and is not: `max_instances` counts running instances, so a destroyed project went on
     * occupying a slot for the whole idle window. With the cap at 2, two of those are the entire
     * capacity — and every call that would free them needs a slot of its own to run, so the
     * system cannot recover from the outside. `stop()` is what actually gives the slot back.
     */
    async destroy() {
      // `--hos[t]` / `p[i]`: this very script is the command line of the shell running it, so an
      // unbracketed pattern matches that shell — pkill would kill its own parent and the `rm`
      // below would never run, which is how a "destroyed" project kept coming back.
      await sb.exec(`sh -lc "pkill -f 'vite --hos[t]' >/dev/null 2>&1; pkill -9 -f 'p[i] --mode json' >/dev/null 2>&1; rm -rf ${APP} /tmp/boris.*"`)
      // Best effort: a container that is already gone must not turn a delete into an error.
      try { await (sb as unknown as { stop(): Promise<void> }).stop() } catch { /* already stopped */ }
    },
  }
}

function r2Store(bucket: R2Bucket): StaticStore {
  return {
    put: async (key, bytes, contentType) => { await bucket.put(key, bytes, { httpMetadata: { contentType } }) },
    async deletePrefix(prefix, keep) {
      let removed = 0
      let cursor: string | undefined
      do {
        const page = await bucket.list({ prefix, cursor })
        const keys = page.objects.map((o) => o.key).filter((k) => !keep?.has(k))
        if (keys.length) {
          await bucket.delete(keys)
          removed += keys.length
        }
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return removed
    },
  }
}

/** Serve one published file, falling back to index.html so client-side routes work. */
async function serveStatic(bucket: R2Bucket, slug: string, pathname: string): Promise<Response | null> {
  // The hostname's first label becomes a key prefix, so a label is the difference between a
  // private object and a public website. Only slug-shaped labels may address the bucket at all,
  // and never the one holding unpublished builds: `snap.lovbase.app/<appId>/index.html` would
  // otherwise resolve to exactly the key the snapshot writer just created.
  if (slug === SNAP || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) return null
  const clean = pathname.replace(/^\/+/, '') || 'index.html'
  const hit = (await bucket.get(`${slug}/${clean}`)) ?? (await bucket.get(`${slug}/index.html`))
  if (!hit) return null
  const key = hit.key.slice(slug.length + 1)
  return new Response(hit.body, {
    headers: {
      'Content-Type': mimeFor(key),
      // Hashed asset names are immutable; the entry document must never be cached.
      'Cache-Control': key === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    },
  })
}
