// The sandbox HTTP API, shared by the Cloudflare Worker and the Docker runner. Internal token auth;
// the main app is the only caller (app/src/server/sandbox.ts, typed from `SandboxApi` below).
import { Hono, type ErrorHandler, type NotFoundHandler } from 'hono'
import { validator } from 'hono/validator'
import { mimeFor, shq, type SandboxBackend, type SandboxConfig, type SandboxCtx, type StaticStore } from './backend'
import { END, pack, safeRel, unpack, unpackBytes, type AppFile } from './pack'

type Llm = { baseUrl: string; apiKey: string; model: string }
type Target = { workspaceId: string; apiToken: string }
type RunBody = Target & { prompt: string; llm: Llm }

export const APP = '/workspace/app'
const ACTIVITY = '/tmp/boris.jsonl'
const DONE = '/tmp/boris.done'
const PROMPT = '/tmp/boris.prompt'
const SCRIPT = '/tmp/boris.sh'
const PID = '/tmp/boris.pid'
/** The packed tree on its way in; see pack.ts for the shape. */
const RESTORE = '/tmp/lovbase.restore'
/**
 * Whether this container holds a project or only the image's blank template.
 *
 * The image ships the template already installed at `APP` (see the Dockerfile), so "is there a
 * package.json" stopped meaning anything. What the caller wants to know is whether real files
 * have landed here since the container came up — a restored snapshot, a written file, a build —
 * and that is what this marker records. It lives outside the app tree so a snapshot never carries
 * it, and in /tmp so it goes away with the container, which is exactly when the answer changes.
 *
 * Starting the dev server does not set it: a preview only reads, and a container that had merely
 * been previewed must still restore its snapshot before anything reads a file.
 */
const OWNED = '/tmp/lovbase.owned'
/** Monotonic fencing token claimed by the scheduler before it controls this container. */
const GENERATION = '/tmp/lovbase.generation'
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
/** How many files of a build go up to object storage at the same time. */
const UPLOADS_AT_ONCE = 8
/** What `/exec` will run. Names only in the arguments: no flags that take paths, no shell metacharacters. */
const ALLOWED_COMMANDS = [
  /^bun run (build|typecheck|format)$/,
  /^bun install$/,
  /^bun add( [A-Za-z0-9@][A-Za-z0-9@/._^~-]{0,80}){1,8}$/,
  /^bunx shadcn@latest add( [a-z0-9-]{1,40}){1,8}$/,
]
/**
 * Where a built copy of an app lives when nobody published it.
 *
 * Deliberately not a slug: `serveStatic` turns the hostname's first label into a key prefix, so
 * anything reachable as a label is a public website. This prefix is refused there (see the guard
 * in `serveStatic`), and the main app serves it instead, behind the same ownership check as the
 * project — a generated app is private until its author decides otherwise.
 */
export const SNAP = 'snap'
/**
 * What is ours to photograph: one label under the apps zone — a published app's slug, or a live
 * preview's `5173-<app>-<token>`. A cover is taken from the preview after a build now, so an app
 * that was built and never published stops wearing a wireframe. Anything else is refused.
 */
// The underscore is for the preview token — the sandbox SDK mints them with one in, and a guard
// that did not know that turned every cover of an unpublished app into a silent `bad url`.
const OURS_TO_SHOOT = /^[a-z0-9][a-z0-9_-]{1,60}\.lovbase\.app$/

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
  .post('/apps/:id/lease', json<{ generation: number }>(), async (c) => {
    const generation = Math.trunc(c.req.valid('json').generation)
    if (generation < 1) return c.json({ error: 'bad generation' }, 400)
    let current = 0
    try { current = Number(await c.var.sb.readFile(GENERATION)) || 0 } catch { /* fresh container */ }
    if (generation < current) return c.json({ error: 'stale sandbox generation' }, 409)
    if (generation > current) await c.var.sb.writeFile(GENERATION, String(generation))
    return c.json({ ok: true, generation })
  })
  .use('/apps/:id/*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (/\/(lease|activity|logs|unpublish|destroy)$/.test(path)) return next()
    const supplied = Math.trunc(Number(c.req.header('x-lovbase-generation') ?? 0))
    let current = 0
    try { current = Number(await c.var.sb.readFile(GENERATION)) || 0 } catch { /* fresh container */ }
    // A generation-bearing caller must have claimed this particular container first. Headerless
    // legacy reads remain possible only while no scheduler-owned lease exists.
    if ((supplied && supplied !== current) || (!supplied && current))
      return c.json({ error: 'stale sandbox generation' }, 409)
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
  /**
   * One command in the app directory, for the agent that now builds the app itself.
   *
   * Allowlisted here, on this side of the boundary, because the request comes from a model: the
   * commands are the ones a build legitimately needs — typecheck, format, build, install a
   * package, add a shadcn component — and their arguments are names, not shell. Anything else is
   * refused before a shell ever sees it.
   */
  .post('/apps/:id/exec', json<{ command: string }>(), async (c) => {
    const { command } = c.req.valid('json')
    if (!ALLOWED_COMMANDS.some((re) => re.test(command))) return c.json({ error: `command not allowed: ${command.slice(0, 80)}` }, 400)
    await ensureProject(c.var.sb)
    await own(c.var.sb)
    const r = await c.var.sb.exec(`cd ${APP} && ${command}`, { timeoutMs: 180_000 })
    return c.json({ ok: r.success, stdout: r.stdout.slice(-8000), stderr: r.stderr.slice(-8000) })
  })
  .get('/apps/:id/logs', async (c) => c.json(await c.var.sb.logs()))
  .get('/apps/:id/files', async (c) => {
    const { files } = await listProjectFiles(c.var.sb)
    return c.json({ files: files.filter((f) => !INTERNAL.test(f.path)) })
  })
  // A sandbox loses its filesystem when the container is evicted, so the app keeps a snapshot
  // in Postgres. These three endpoints are how it takes one and puts it back.
  .get('/apps/:id/state', async (c) => c.json({ fresh: !(await c.var.sb.exists(OWNED)) }))
  .get('/apps/:id/export', async (c) => {
    await ensureProject(c.var.sb)
    // The whole tree in one exec, as line pairs the codec reads back (see pack.ts). `-prune` is
    // what keeps this fast: without it `find` walks node_modules just to reject every file in it.
    // The sentinel is printed last; `unpack` refuses a stream that does not end with it.
    const r = await c.var.sb.exec([
      `cd ${APP}`,
      "&& find . \\( -name node_modules -o -name dist -o -name .git -o -name .pi \\) -prune",
      "-o -type f ! -name bun.lock",
      `-exec sh -c 'printf "%s\\n" "\${1#./}"; base64 -w0 < "$1"; printf "\\n"' _ {} \\;`,
      `&& printf '%s\\n' ${shq(END)}`,
    ].join(' '))
    return c.json({ files: unpack(r.stdout) })
  })
  .post('/apps/:id/import', json<{ files: AppFile[] }>(), async (c) => {
    const { files } = c.req.valid('json')
    await ensureProject(c.var.sb)
    // One write of the packed tree, one exec to unpack it. `pack` has already dropped anything
    // that escapes the tree; the `case` is the shell refusing the same, so neither side trusts
    // the other to have done it.
    await c.var.sb.writeFile(RESTORE, pack(files))
    const r = await c.var.sb.exec([
      `cd ${APP}`,
      `&& while IFS= read -r p && IFS= read -r b; do`,
      `case "$p" in ${shq(END)}) break;; *..*|/*|"") continue;; esac;`,
      'mkdir -p "$(dirname "$p")" && printf "%s" "$b" | base64 -d > "$p" || exit 1;',
      `done < ${RESTORE}`,
    ].join(' '))
    if (!r.success) return c.json({ error: 'restore failed: ' + r.stderr.slice(-800) }, 500)
    await own(c.var.sb)
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
    await own(c.var.sb)
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
    if (target.protocol !== 'https:' || !OURS_TO_SHOOT.test(target.hostname)) return c.json({ error: 'bad url' }, 400)
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
/**
 * Make sure there is an app directory to work in.
 *
 * Normally there is nothing to do: the image has the template installed at `APP` already. This
 * only runs when the directory was dropped while the container stayed up — `destroy` does that
 * before releasing the instance — and then it rebuilds it from the pristine source, dependencies
 * included, which is the slow path this used to be on every cold start.
 *
 * Copy the template's contents in, not the directory: the app dir may already exist (a file was
 * written before the first run), and `cp -r dir target` would then nest it as target/template.
 */
async function ensureProject(sb: SandboxBackend) {
  if (await sb.exists(`${APP}/package.json`)) return
  const r = await sb.exec(`mkdir -p ${APP} && cp -a /opt/template/. ${APP}/ && cd ${APP} && bun install`, { timeoutMs: 300_000 })
  if (!r.success) throw new Error('bun install failed: ' + r.stderr.slice(-800))
}

/** Real files have landed here: from now on this container is a project, not a template. */
const own = (sb: SandboxBackend) => sb.writeFile(OWNED, '')

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
  await own(sb)
  // pi provider config: the workspace owner's model, OpenAI-compatible. The key goes in the
  // container-private file rather than env, which does not reach exec'd processes reliably.
  await sb.exec('mkdir -p /root/.pi/agent')
  // A relative base is the app's own relay, reached at whatever address this container knows the
  // app by — `lovbase.dev` in production, `host.docker.internal` under the local runner. The app
  // cannot know that address for the container, so it does not try to.
  const baseUrl = body.llm.baseUrl.startsWith('/') ? cfg.apiUrl.replace(/\/+$/, '') + body.llm.baseUrl : body.llm.baseUrl
  await sb.writeFile('/root/.pi/agent/models.json', JSON.stringify({
    providers: {
      lovbase: {
        baseUrl,
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

/** Three tries, a couple of seconds apart, for a call whose failure is more often the platform's than ours. */
async function withRetries<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (err) { last = err; if (i < tries - 1) await new Promise((r) => setTimeout(r, 2000)) }
  }
  throw last
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
    // A build is minutes of this one exec, and the container's control plane occasionally answers
    // a single call with a 500 — seen in production as `SandboxError: HTTP error! status: 500`,
    // which took a whole turn down with it. One blip in a thirty-minute watch is not a failed
    // build; three in a row is.
    const line = (await withRetries(() => sb.exec(`cat ${DONE} 2>/dev/null || true`))).stdout.trim()
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
  // The exit code is not the verdict. pi returns 0 after a turn in which the model never
  // answered, and a build that "succeeded" over an untouched app is worse than one that failed:
  // the agent reports done, the user sees the template, and nothing says why.
  const failure = turnFailure(out.stdout)
  return {
    done: true,
    ok: code === '0' && !failure,
    output: out.stdout.slice(-20_000),
    stderr: (failure ? `${failure}\n` : '') + err.stdout.slice(-4000),
    previewUrl: p.previewUrl,
  }
}

/**
 * What the transcript says went wrong, when the exit code says nothing did.
 *
 * Two shapes mean the turn produced no work: retries exhausted (`auto_retry_end` with `success`
 * false is only written once pi has given up), and the last assistant message ending with
 * `stopReason: "error"`. The last one, not any one — an early failure followed by a real answer
 * is a turn that worked.
 */
function turnFailure(jsonl: string): string | null {
  let exhausted: string | null = null
  let lastAssistant: string | null = null
  for (const line of jsonl.split('\n')) {
    if (!line.startsWith('{')) continue
    let e: any
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'auto_retry_end' && e.success === false) exhausted = String(e.finalError ?? 'model request failed')
    if (e.type === 'message_end' && e.message?.role === 'assistant')
      lastAssistant = e.message.stopReason === 'error' ? String(e.message.errorMessage ?? 'model request failed') : null
  }
  return exhausted ?? lastAssistant
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
  // The built tree in one exec, the way `/export` moves the source: it used to be a listing and
  // then one exec per file, each a round trip into the container, and a build is dozens of files.
  // Then the uploads a few at a time rather than one after another — object storage does not
  // care, and the person watching "Publishing…" does.
  const packed = await sb.exec([
    `cd ${APP}/dist`,
    `&& find . -type f -exec sh -c 'printf "%s\\n" "\${1#./}"; base64 -w0 < "$1"; printf "\\n"' _ {} \\;`,
    `&& printf '%s\\n' ${shq(END)}`,
  ].join(' '))
  const files = packed.success ? unpackBytes(packed.stdout) : []
  if (files.length === 0) return { ok: false as const, error: 'The build produced no files', stderr: built.stdout.slice(-1500) }
  const written = new Set<string>()
  for (let i = 0; i < files.length; i += UPLOADS_AT_ONCE) {
    await Promise.all(files.slice(i, i + UPLOADS_AT_ONCE).map(async ({ path, bytes }) => {
      const key = `${prefix}/${path}`
      await store.put(key, bytes, mimeFor(path))
      written.add(key)
    }))
  }
  // After the new files are up, not before: pruning first would leave the app 404ing for as long
  // as the upload takes, and this is a live address. What is left over is the previous build's
  // content-hashed chunks, which nothing points at any more.
  const removed = await store.deletePrefix(`${prefix}/`, written)
  return { ok: true as const, files: written.size, removed }
}

async function listProjectFiles(sb: SandboxBackend) {
  await ensureProject(sb)
  const files = (await sb.listFiles(APP)).filter((f) => !SKIP.test(f.path)).toSorted((a, b) => a.path.localeCompare(b.path))
  return { files }
}
