// Cloudflare host for the sandbox API: one Sandbox container per app (Durable Object), previews
// proxied straight into the container, published apps served from R2. The API itself is in app.ts.
import { Hono } from 'hono'
import { Sandbox, getSandbox, proxyToSandbox } from '@cloudflare/sandbox'
import { notFound, onError, sandboxApi } from './app'
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
      // Idle containers are the one cost that runs away on its own: every build leaves one warm.
      // A live preview keeps renewing this through its own requests, so a short window is safe.
      backend: (appId, hostname) => cloudflareBackend(getSandbox(env.Sandbox, appId, { sleepAfter: env.SANDBOX_SLEEP_AFTER || '5m' }), hostname),
    })
    await next()
  })
  .route('/', sandboxApi)
  .notFound(notFound)
  .onError(onError)

export default app

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
    // Stop anything running and drop the project directory, then let the container sleep out.
    async destroy() {
      await sb.exec(`sh -lc "pkill -f 'vite --host' >/dev/null 2>&1; rm -rf ${APP} /tmp/boris.*"`)
    },
  }
}

function r2Store(bucket: R2Bucket): StaticStore {
  return {
    put: async (key, bytes, contentType) => { await bucket.put(key, bytes, { httpMetadata: { contentType } }) },
    async deletePrefix(prefix) {
      let removed = 0
      let cursor: string | undefined
      do {
        const page = await bucket.list({ prefix, cursor })
        if (page.objects.length) {
          await bucket.delete(page.objects.map((o) => o.key))
          removed += page.objects.length
        }
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return removed
    },
  }
}

/** Serve one published file, falling back to index.html so client-side routes work. */
async function serveStatic(bucket: R2Bucket, slug: string, pathname: string): Promise<Response | null> {
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
