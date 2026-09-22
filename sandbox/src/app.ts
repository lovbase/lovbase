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
const PID = '/tmp/boris.pid'
/** How often a parked poll looks for the done marker. */
const POLL_MS = 2000
const SKIP = /(^|\/)(node_modules|dist|\.git|\.pi|bun\.lock)(\/|$)/
/**
 * Ours, not theirs: files the template puts in the project to steer the coding agent.
 *
 * Hidden from the file list rather than from the project — Boris reads `AGENTS.md` off the
 * filesystem and has to keep finding it. It is our instructions to our agent, in our words, and
 * someone opening the code pane to look at the app they asked for should not have to scroll past
 * it, or wonder whether editing it is expected of them.
 *
 * Only the listing filters on this. `/export` must keep returning it, or the snapshot in Postgres
 * would restore a project with the agent's briefing missing.
 */
const INTERNAL = /^AGENTS\.md$/
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/
/**
 * Where a built copy of an app lives when nobody published it.
 *
 * Deliberately not a slug: `serveStatic` turns the hostname's first label into a key prefix, so
 * anything reachable as a label is a public website. This prefix is refused there (see the guard
 * in `serveStatic`), and the main app serves it instead, behind the same ownership check as the
 * project — a generated app is private until its author decides otherwise.
 */
export const SNAP = 'snap'
/** A published app: one label under the apps zone. Nothing else is ours to photograph. */
const PUBLISHED_HOST = /^[a-z0-9][a-z0-9-]{1,40}\.lovbase\.app$/

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
  // Starting a turn and waiting for it are two requests, not one: see `startRun`.
  .post('/apps/:id/run', json<RunBody>(), async (c) => c.json(await startRun(c.var.sb, c.var.sandbox.config, c.req.valid('json'))))
  .post('/apps/:id/run/poll', json<{ runId: string; waitMs?: number }>(), async (c) => {
    const { runId, waitMs } = c.req.valid('json')
    return c.json(await pollRun(c.var.sb, runId, waitMs ?? 60_000))
  })
  .post('/apps/:id/run/stop', async (c) => {
    await stopBoris(c.var.sb)
    return c.json({ ok: true })
  })
  // Live view of the current Boris turn: the JSONL the agent is writing right now, from `from`
  // bytes in. The caller keeps what it already has (see `activitySince`).
  .get('/apps/:id/activity', query<{ from?: string }>(), async (c) => {
    const from = Math.max(0, Math.trunc(Number(c.req.valid('query').from ?? 0)) || 0)
    return c.json(await activitySince(c.var.sb, from))
  })
  .post('/apps/:id/preview', json<Target>(), async (c) => {
    await configure(c.var.sb, c.var.sandbox.config, c.req.valid('json'))
    return c.json(await c.var.sb.preview())
  })
  .post('/apps/:id/build', async (c) => c.json(await build(c.var.sb)))
  .get('/apps/:id/logs', async (c) => c.json(await c.var.sb.logs()))
  .get('/apps/:id/files', async (c) => {
    const { files } = await listProjectFiles(c.var.sb)
    return c.json({ files: files.filter((f) => !INTERNAL.test(f.path)) })
  })
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
  /**
   * A cover image for a published app. Takes a URL rather than an app id because the thing being
   * photographed is the published copy in object storage, which outlives the container — asking
   * for a container here would wake one up to photograph something it is not serving.
   */
  .post('/thumb', json<{ url: string }>(), async (c) => {
    const shoot = c.var.sandbox.shoot
    if (!shoot) return c.json({ error: 'no browser bound; covers are unavailable on this backend' }, 501)
    const { url } = c.req.valid('json')
    let target: URL
    try { target = new URL(url) } catch { return c.json({ error: 'bad url' }, 400) }
    // Only ever photograph our own published apps. A browser that will fetch any URL an API
    // caller hands it is an SSRF hole with a rendering engine attached.
    if (target.protocol !== 'https:' || !PUBLISHED_HOST.test(target.hostname)) return c.json({ error: 'bad url' }, 400)
    try {
      return new Response(await shoot(target.toString()), { headers: { 'content-type': 'image/png' } })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'screenshot failed' }, 502)
    }
  })
  .post('/apps/:id/publish', json<{ slug: string }>(), async (c) => {
    const store = c.var.sandbox.store
    if (!store) return c.json({ error: 'no static store bound; publishing is unavailable on this backend' }, 501)
    const { slug } = c.req.valid('json')
    if (!SLUG.test(slug)) return c.json({ error: 'bad slug' }, 400)
    return c.json(await buildInto(c.var.sb, store, slug))
  })
  /**
   * A built copy of the app, kept so reopening it does not need a container.
   *
   * The same machinery as publishing, under a private prefix: opening an old project used to mean
   * a cold container, its source restored a file at a time, and a dev server booting — minutes
   * before the first pixel. With this the last build is on screen at once and a container is only
   * woken when something has to be live.
   */
  .post('/apps/:id/snapshot', async (c) => {
    const store = c.var.sandbox.store
    if (!store) return c.json({ ok: false as const, error: 'no static store bound' }, 501)
    const id = c.req.param('id')
    return c.json(await buildInto(c.var.sb, store, `${SNAP}/${id}`, `/api/snap/${id}/`))
  })
  // Reclaiming resources when an app is deleted: the published copy, then the container.
  .post('/apps/:id/unpublish', json<{ slug: string }>(), async (c) => {
    const store = c.var.sandbox.store
    if (!store) return c.json({ ok: true, removed: 0 })
    const { slug } = c.req.valid('json')
    if (!SLUG.test(slug)) return c.json({ error: 'bad slug' }, 400)
    return c.json({ ok: true, removed: await store.deletePrefix(`${slug}/`) })
  })
  /**
   * Give the container's slot back, and keep everything that outlives it.
   *
   * Freeing a container and deleting an app are not the same act, and a single endpoint doing
   * both made the cheaper one destructive: stopping a container to reclaim capacity also threw
   * away the built copy whose entire purpose is to make the next cold start unnecessary. This is
   * the one to call to stop something. It leaves the snapshot and the source alone.
   */
  .post('/apps/:id/stop', async (c) => {
    try { await c.var.sb.stop() } catch { /* already stopped */ }
    return c.json({ ok: true })
  })
  .post('/apps/:id/destroy', async (c) => {
    // For an app being deleted, not one being stopped: the built copy outlives the container, so
    // dropping the container alone would leave a deleted app still served.
    try { await c.var.sandbox.store?.deletePrefix(`${SNAP}/${c.req.param('id')}/`) } catch { /* nothing stored */ }
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

/**
 * Point both the container CLI and the Vite app at the workspace's data API.
 *
 * The `.env` write is conditional because Vite restarts its dev server whenever one changes, and
 * this runs at the top of every turn and every preview — so rewriting the same three lines was
 * bouncing the server the preview is served from, for nothing.
 */
async function configure(sb: SandboxBackend, cfg: SandboxConfig, t: Target) {
  await ensureProject(sb)
  await sb.setEnv?.({ LOVBASE_API_URL: cfg.apiUrl, LOVBASE_WORKSPACE: t.workspaceId, LOVBASE_TOKEN: t.apiToken })
  const env = [
    `VITE_LOVBASE_URL=${cfg.publicApiUrl}`,
    `VITE_LOVBASE_WORKSPACE=${t.workspaceId}`,
    `VITE_LOVBASE_TOKEN=${t.apiToken}`,
  ].join('\n')
  let current: string | null = null
  try { current = await sb.readFile(`${APP}/.env`) } catch { /* not written yet */ }
  if (current !== env) await sb.writeFile(`${APP}/.env`, env)
}

/**
 * The agent's event stream from `from` bytes in, rather than its last 200KB every time.
 *
 * The chat polls this for the whole of a build, and each poll is an `exec` in the container that
 * is running the agent — on a half-vCPU box, across regions. Re-sending the entire transcript on
 * every tick made the watching cost grow with the length of the turn it was watching. The reply
 * carries `next` for the following call; `from` past the end of the file means the file was
 * replaced (a new turn) and the caller is handed the tail and told to start over.
 */
const ACTIVITY_TAIL = 200_000
async function activitySince(sb: SandboxBackend, from: number) {
  // One line of `<size> <start>`, then the bytes. `start` differs from `from` when the file was
  // truncated under us, or when a first read would otherwise pull back more than the tail cap.
  const r = await sb.exec([
    `f=${ACTIVITY}`,
    // Not `$(wc … || echo 0)`: with a pipe in it the fallback would hang off the pipeline's exit
    // status, not wc's, and an unreadable file would set an empty size rather than zero.
    'sz=0',
    '[ -f "$f" ] && sz=$(wc -c < "$f" | tr -d " ")',
    `s=${from}`,
    'if [ "$sz" -lt "$s" ]; then s=0; fi',
    `if [ $((sz - s)) -gt ${ACTIVITY_TAIL} ]; then s=$((sz - ${ACTIVITY_TAIL})); fi`,
    'echo "$sz $s"',
    'tail -c +$((s + 1)) "$f" 2>/dev/null || true',
  ].join('\n'))
  const nl = r.stdout.indexOf('\n')
  if (nl < 0) return { jsonl: '', from, next: from, reset: false }
  const [size, start] = r.stdout.slice(0, nl).trim().split(' ').map(Number)
  if (!Number.isFinite(size) || !Number.isFinite(start)) return { jsonl: '', from, next: from, reset: false }
  return { jsonl: r.stdout.slice(nl + 1), from: start, next: size, reset: start !== from }
}

/**
 * Kill the agent process this container is running, if any.
 *
 * `p[i]` rather than `pi`: `exec` runs a script as `sh -lc '<script>'`, so the script's own text is
 * that shell's command line — a literal `pi --mode json` would make pkill match, and kill, its own
 * parent. The bracket matches the same processes without appearing in one.
 */
async function stopBoris(sb: SandboxBackend) {
  await sb.exec(
    `pid=$(cat ${PID} 2>/dev/null); [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null; ` +
    `pkill -9 -f 'p[i] --mode json' 2>/dev/null; rm -f ${PID}; true`,
  )
}

/**
 * Start Boris and return, rather than holding the request open for the whole turn.
 *
 * A build runs for minutes and the caller's `fetch` does not: Node's undici abandons a request
 * whose response headers have not arrived in 300 seconds, so every turn that ran past five minutes
 * died as `TypeError: fetch failed` — having burned the full five minutes — and the agent started
 * over. The turn is polled instead (`/run/poll`), in windows short enough that no timeout applies.
 */
async function startRun(sb: SandboxBackend, cfg: SandboxConfig, body: RunBody) {
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

  // A previous turn's agent may still be in here. It is detached, so a caller that stopped waiting
  // never stopped it — and two agents editing the same tree is what produces a build that reports
  // success over an app nothing changed in: whichever exits first writes the done marker, and the
  // other is still typing when the result is read, formatted and snapshotted.
  await stopBoris(sb)

  // The marker names the run it belongs to, so a straggler from an earlier turn can never be
  // mistaken for this one finishing.
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  // The brief goes in a file so no shell quoting can mangle it, and Boris runs detached: blocking
  // one long exec would also block GET /activity, and the point of the JSON event stream is that
  // the user can watch it.
  await sb.writeFile(PROMPT, body.prompt)
  await sb.writeFile(SCRIPT, [
    '#!/bin/sh',
    `cd ${APP}`,
    `rm -f ${ACTIVITY} ${DONE}`,
    `pi --mode json -p "$(cat ${PROMPT})" --provider lovbase --model ${shq(body.llm.model)} > ${ACTIVITY} 2> ${ACTIVITY}.err &`,
    // pi's own pid, not the wrapper's: killing the wrapper would orphan the agent, which is the
    // state this whole mechanism exists to prevent.
    `echo $! > ${PID}`,
    'wait $!',
    `echo ${shq(runId)} $? > ${DONE}`,
  ].join('\n'))
  await sb.exec(`nohup sh ${SCRIPT} > /dev/null 2>&1 &`, { cwd: APP, env })
  return { runId }
}

/**
 * Wait up to `waitMs` for this run to finish. `done: false` means "ask again" — the caller loops,
 * and each request stays short enough that no client or proxy timeout applies to it.
 */
async function pollRun(sb: SandboxBackend, runId: string, waitMs: number) {
  const deadline = Date.now() + waitMs
  let code: string | null = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const line = (await sb.exec(`cat ${DONE} 2>/dev/null || true`)).stdout.trim()
    if (line.startsWith(`${runId} `)) { code = line.slice(runId.length + 1).trim(); break }
  }
  if (code === null) return { done: false, ok: false, output: '', stderr: '', previewUrl: '' }
  // Models write dense one-liners when left alone, and people read this code in the editor.
  // Formatting is a build step, not a request: run it regardless of what the agent produced —
  // but only over what it touched. The whole tree through prettier on half a vCPU was a fixed
  // charge of several seconds on every turn, most of it re-formatting files nothing had changed.
  // The prompt file is written the instant before the agent starts, so "newer than it" is exactly
  // the set of files this turn wrote.
  await sb.exec([
    `cd ${APP}`,
    `find src -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \\) -newer ${PROMPT} -print`,
    '| xargs -r ./node_modules/.bin/prettier --write > /dev/null 2>&1 || true',
  ].join(' '))
  const out = await sb.exec(`tail -c 400000 ${ACTIVITY} 2>/dev/null || true`)
  const err = await sb.exec(`tail -c 4000 ${ACTIVITY}.err 2>/dev/null || true`)
  const p = await sb.preview()
  return { done: true, ok: code === '0', output: out.stdout.slice(-20_000), stderr: err.stdout.slice(-4000), previewUrl: p.previewUrl }
}

async function build(sb: SandboxBackend) {
  await ensureProject(sb)
  const r = await sb.exec(`cd ${APP} && bun run build`, { timeoutMs: 300_000 })
  if (!r.success) return { ok: false as const, stderr: r.stderr.slice(-4000) }
  const files = await sb.listFiles(`${APP}/dist`)
  return { ok: true as const, files: files.map((f) => f.path) }
}

/**
 * Build the app and copy dist/ into the store under `prefix`. Files go through base64 because
 * the backends' file APIs are text-only and a Vite build contains fonts and images.
 */
async function buildInto(sb: SandboxBackend, store: StaticStore, prefix: string, base?: string) {
  // A published app sits at the root of its own subdomain; a snapshot is served from a path inside
  // the main app, and Vite writes absolute asset URLs, so it has to be told where it will live.
  const built = await sb.exec(`cd ${APP} && bun run build${base ? ` --base=${shq(base)}` : ''} 2>&1 | tail -20`)
  const paths = (await sb.listFiles(`${APP}/dist`)).map((f) => f.path)
  if (paths.length === 0) return { ok: false as const, error: '构建没有产出文件', stderr: built.stdout.slice(-1500) }
  const written = new Set<string>()
  for (const rel of paths) {
    const raw = (await sb.exec(`base64 < ${shq(`${APP}/dist/${rel}`)} | tr -d '\\n'`)).stdout.trim()
    if (!raw) continue
    const key = `${prefix}/${rel}`
    await store.put(key, Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0)), mimeFor(rel))
    written.add(key)
  }
  // After the new files are up, not before: pruning first would leave the app 404ing for as long
  // as the upload takes, and this is a live address. What is left over is the previous build's
  // content-hashed chunks, which nothing points at any more.
  const removed = await store.deletePrefix(`${prefix}/`, written)
  return { ok: true as const, files: written.size, removed }
}

/** Relative paths only, inside the app dir, no traversal. */
function safeRel(p: string): string | null {
  const rel = p.replace(/^\/+/, '')
  if (!rel || rel.includes('..') || rel.includes('\0')) return null
  return rel
}

async function listProjectFiles(sb: SandboxBackend) {
  await ensureProject(sb)
  const files = (await sb.listFiles(APP)).filter((f) => !SKIP.test(f.path)).toSorted((a, b) => a.path.localeCompare(b.path))
  return { files }
}
