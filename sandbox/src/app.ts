// The sandbox HTTP API, shared by the Cloudflare Worker and the Docker runner. Internal token auth;
// the main app is the only caller (app/src/server/sandbox.ts, typed from `SandboxApi` below).
import { Hono, type ErrorHandler, type NotFoundHandler } from 'hono'
import { validator } from 'hono/validator'
import { mimeFor, shq, type SandboxBackend, type SandboxConfig, type SandboxCtx, type StaticStore } from './backend'

type Llm = { baseUrl: string; apiKey: string; model: string }
type Target = { workspaceId: string; apiToken: string }
type RunBody = Target & { prompt: string; llm: Llm }
type AppFile = { path: string; content: string }

export const APP = '/workspace/app'
const ACTIVITY = '/tmp/boris.jsonl'
const DONE = '/tmp/boris.done'
const PROMPT = '/tmp/boris.prompt'
const SCRIPT = '/tmp/boris.sh'
const SKIP = /(^|\/)(node_modules|dist|\.git|\.pi|bun\.lock)(\/|$)/
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/

type Env = { Variables: { sandbox: SandboxCtx; sb: SandboxBackend } }

/** Declares the body shape for the typed client; the main app is the only caller, so no schema validation. */
const json = <T,>() => validator('json', (v) => v as T)
const query = <T,>() => validator('query', (v) => v as T)

export const sandboxApi = new Hono<Env>()
  .use('*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${c.var.sandbox.token}`) return c.json({ error: 'unauthorized' }, 401)
    await next()
  })
  .use('/apps/:id/*', async (c, next) => {
    const id = c.req.param('id')
    if (!/^[a-z0-9]+$/.test(id)) return c.json({ error: 'bad app id' }, 400)
    c.set('sb', c.var.sandbox.backend(id, new URL(c.req.url).host))
    await next()
  })
  .post('/apps/:id/run', json<RunBody>(), async (c) => c.json(await run(c.var.sb, c.var.sandbox.config, c.req.valid('json'))))
  // Live view of the current Boris turn: the JSONL the agent is writing right now.
  .get('/apps/:id/activity', async (c) => {
    const r = await c.var.sb.exec(`tail -c 200000 ${ACTIVITY} 2>/dev/null || true`)
    return c.json({ jsonl: r.stdout })
  })
  .post('/apps/:id/preview', json<Target>(), async (c) => {
    await configure(c.var.sb, c.var.sandbox.config, c.req.valid('json'))
    return c.json(await c.var.sb.preview())
  })
  .post('/apps/:id/build', async (c) => c.json(await build(c.var.sb)))
  .get('/apps/:id/logs', async (c) => c.json(await c.var.sb.logs()))
  .get('/apps/:id/files', async (c) => c.json(await listProjectFiles(c.var.sb)))
  // A sandbox loses its filesystem when the container is evicted, so the app keeps a snapshot
  // in Postgres. These three endpoints are how it takes one and puts it back.
  .get('/apps/:id/state', async (c) => c.json({ fresh: !(await c.var.sb.exists(`${APP}/package.json`)) }))
  .get('/apps/:id/export', async (c) => {
    const { files } = await listProjectFiles(c.var.sb)
    const out: AppFile[] = []
    for (const f of files) {
      try { out.push({ path: f.path, content: await c.var.sb.readFile(`${APP}/${f.path}`) }) } catch { /* skip unreadable */ }
    }
    return c.json({ files: out })
  })
  .post('/apps/:id/import', json<{ files: AppFile[] }>(), async (c) => {
    const { files } = c.req.valid('json')
    await ensureProject(c.var.sb)
    for (const f of files) {
      const rel = safeRel(f.path)
      if (rel) await c.var.sb.writeFile(`${APP}/${rel}`, f.content)
    }
    return c.json({ ok: true, restored: files.length })
  })
  .get('/apps/:id/file', query<{ path: string }>(), async (c) => {
    const rel = safeRel(c.req.valid('query').path ?? '')
    if (!rel) return c.json({ error: 'bad path' }, 400)
    try { return c.json({ path: rel, content: await c.var.sb.readFile(`${APP}/${rel}`) }) } catch { return c.json({ error: 'not found' }, 404) }
  })
  .put('/apps/:id/file', query<{ path: string }>(), json<{ content: string }>(), async (c) => {
    const rel = safeRel(c.req.valid('query').path ?? '')
    if (!rel) return c.json({ error: 'bad path' }, 400)
    const { content } = c.req.valid('json')
    await ensureProject(c.var.sb)
    await c.var.sb.writeFile(`${APP}/${rel}`, content)
    return c.json({ ok: true, path: rel })
  })
  // Published apps: built once, copied into object storage, served from there so the container can sleep.
  .post('/apps/:id/publish', json<{ slug: string }>(), async (c) => {
    const store = c.var.sandbox.store
    if (!store) return c.json({ error: 'no static store bound; publishing is unavailable on this backend' }, 501)
    const { slug } = c.req.valid('json')
    if (!SLUG.test(slug)) return c.json({ error: 'bad slug' }, 400)
    return c.json(await publish(c.var.sb, store, slug))
  })
  // Reclaiming resources when an app is deleted: the published copy, then the container.
  .post('/apps/:id/unpublish', json<{ slug: string }>(), async (c) => {
    const store = c.var.sandbox.store
    if (!store) return c.json({ ok: true, removed: 0 })
    const { slug } = c.req.valid('json')
    if (!SLUG.test(slug)) return c.json({ error: 'bad slug' }, 400)
    return c.json({ ok: true, removed: await store.deletePrefix(`${slug}/`) })
  })
  .post('/apps/:id/destroy', async (c) => {
    try { await c.var.sb.destroy() } catch { /* already gone */ }
    return c.json({ ok: true })
  })

/** The main app derives its client from this; a route change there is a compile error. */
export type SandboxApi = typeof sandboxApi

/** Hosts mount `sandboxApi` and install these: Hono resolves 404s and errors on the outermost app. */
export const notFound: NotFoundHandler<any> = (c) => c.json({ error: 'not found' }, 404)
export const onError: ErrorHandler<any> = (err, c) => c.json({ error: err.message }, 500)

/** Copy the template on first use and install deps. Idempotent. */
async function ensureProject(sb: SandboxBackend) {
  if (await sb.exists(`${APP}/package.json`)) return
  // Copy the template's contents in, not the directory: the app dir may already exist (a file was
  // written before the first run), and `cp -r dir target` would then nest it as target/template.
  const r = await sb.exec(`mkdir -p ${APP} && cp -a /opt/template/. ${APP}/ && cd ${APP} && bun install`, { timeoutMs: 300_000 })
  if (!r.success) throw new Error('bun install failed: ' + r.stderr.slice(-800))
}

/** Point both the container CLI and the Vite app at the workspace's data API. */
async function configure(sb: SandboxBackend, cfg: SandboxConfig, t: Target) {
  await ensureProject(sb)
  await sb.setEnv?.({ LOVBASE_API_URL: cfg.apiUrl, LOVBASE_WORKSPACE: t.workspaceId, LOVBASE_TOKEN: t.apiToken })
  await sb.writeFile(`${APP}/.env`, [
    `VITE_LOVBASE_URL=${cfg.publicApiUrl}`,
    `VITE_LOVBASE_WORKSPACE=${t.workspaceId}`,
    `VITE_LOVBASE_TOKEN=${t.apiToken}`,
  ].join('\n'))
}

async function run(sb: SandboxBackend, cfg: SandboxConfig, body: RunBody) {
  await configure(sb, cfg, body)
  // pi provider config: the workspace owner's model, OpenAI-compatible. The key goes in the
  // container-private file rather than env, which does not reach exec'd processes reliably.
  await sb.exec('mkdir -p /root/.pi/agent')
  await sb.writeFile('/root/.pi/agent/models.json', JSON.stringify({
    providers: {
      lovbase: {
        baseUrl: body.llm.baseUrl,
        api: 'openai-completions',
        apiKey: body.llm.apiKey,
        models: [{ id: body.llm.model, name: body.llm.model, contextWindow: 128000, maxTokens: 16384, input: ['text'], reasoning: false }],
      },
    },
  }, null, 2))

  const env: Record<string, string> = {
    LOVBASE_API_URL: cfg.apiUrl, LOVBASE_WORKSPACE: body.workspaceId, LOVBASE_TOKEN: body.apiToken,
    // Dev-only egress proxy; the Lovbase API on the host must bypass it.
    ...(cfg.httpProxy ? { HTTPS_PROXY: cfg.httpProxy, HTTP_PROXY: cfg.httpProxy, NO_PROXY: 'host.docker.internal,localhost,127.0.0.1' } : {}),
  }
  // The brief goes in a file so no shell quoting can mangle it, and Boris runs detached: blocking
  // one long exec would also block GET /activity, and the point of the JSON event stream is that
  // the user can watch it. Polling for the done marker yields between checks.
  await sb.writeFile(PROMPT, body.prompt)
  await sb.writeFile(SCRIPT, [
    '#!/bin/sh',
    `cd ${APP}`,
    `rm -f ${ACTIVITY} ${DONE}`,
    `pi --mode json -p "$(cat ${PROMPT})" --provider lovbase --model ${shq(body.llm.model)} > ${ACTIVITY} 2> ${ACTIVITY}.err`,
    `echo $? > ${DONE}`,
  ].join('\n'))
  const started = Date.now()
  await sb.exec(`nohup sh ${SCRIPT} > /dev/null 2>&1 &`, { cwd: APP, env })
  let code = ''
  for (let i = 0; i < 450 && !code; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    code = (await sb.exec(`cat ${DONE} 2>/dev/null || true`)).stdout.trim()
  }
  // Models write dense one-liners when left alone, and people read this code in the editor.
  // Formatting is a build step, not a request: run it regardless of what the agent produced.
  await sb.exec(`cd ${APP} && bun run format > /dev/null 2>&1 || true`)
  const out = await sb.exec(`tail -c 400000 ${ACTIVITY} 2>/dev/null || true`)
  const err = await sb.exec(`tail -c 4000 ${ACTIVITY}.err 2>/dev/null || true`)
  const p = await sb.preview()
  return { ok: code === '0', output: out.stdout.slice(-20_000), stderr: err.stdout.slice(-4000), duration: Date.now() - started, ...p }
}

async function build(sb: SandboxBackend) {
  await ensureProject(sb)
  const r = await sb.exec(`cd ${APP} && bun run build`, { timeoutMs: 300_000 })
  if (!r.success) return { ok: false as const, stderr: r.stderr.slice(-4000) }
  const files = await sb.listFiles(`${APP}/dist`)
  return { ok: true as const, files: files.map((f) => f.path) }
}

/**
 * Build the app and copy dist/ into the store under the slug. Files go through base64 because
 * the backends' file APIs are text-only and a Vite build contains fonts and images.
 */
async function publish(sb: SandboxBackend, store: StaticStore, slug: string) {
  const built = await sb.exec(`cd ${APP} && bun run build 2>&1 | tail -20`)
  const paths = (await sb.listFiles(`${APP}/dist`)).map((f) => f.path)
  if (paths.length === 0) return { ok: false as const, error: '构建没有产出文件', stderr: built.stdout.slice(-1500) }
  let uploaded = 0
  for (const rel of paths) {
    const raw = (await sb.exec(`base64 < ${shq(`${APP}/dist/${rel}`)} | tr -d '\\n'`)).stdout.trim()
    if (!raw) continue
    await store.put(`${slug}/${rel}`, Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0)), mimeFor(rel))
    uploaded++
  }
  return { ok: true as const, files: uploaded }
}

/** Relative paths only, inside the app dir, no traversal. */
function safeRel(p: string): string | null {
  const rel = p.replace(/^\/+/, '')
  if (!rel || rel.includes('..') || rel.includes('\0')) return null
  return rel
}

async function listProjectFiles(sb: SandboxBackend) {
  await ensureProject(sb)
  const files = (await sb.listFiles(APP)).filter((f) => !SKIP.test(f.path)).sort((a, b) => a.path.localeCompare(b.path))
  return { files }
}
