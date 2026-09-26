// ── Self-hosted sandbox runner ──
// The same API as the Cloudflare Worker (../src/app.ts), backed by plain Docker: one container per
// app, project files on a named volume, Vite published on a host port. Used for local development
// and for deployments without Cloudflare. Isolation = container; put gVisor (runsc) under Docker
// for multi-tenant use.
import Docker from 'dockerode'
import { Hono } from 'hono'
import { APP, notFound, onError, sandboxApi } from '../src/app'
import type { SandboxBackend, SandboxCtx } from '../src/backend'

const docker = new Docker(process.env.DOCKER_HOST ? undefined : { socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' })
const PORT = Number(process.env.PORT ?? 8788)
const TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token'
const IMAGE = process.env.SANDBOX_IMAGE ?? 'lovbase-sandbox:local'
const API_URL = process.env.LOVBASE_API_URL ?? 'http://host.docker.internal:3008'      // seen from inside containers
const PUBLIC_API_URL = process.env.LOVBASE_PUBLIC_API_URL ?? 'http://localhost:3008'   // seen from the viewer's browser
const PREVIEW_HOST = process.env.PREVIEW_HOST ?? 'localhost'                           // where published ports are reachable
const PROXY = process.env.SANDBOX_HTTP_PROXY ?? ''

const nameFor = (id: string) => `lovbase-app-${id}`

// ── Idle containers ──
//
// The Cloudflare backend sleeps a sandbox after `SANDBOX_SLEEP_AFTER` (../src/index.ts), and the
// cost model in core/src/billing.ts is written around that: an agent sandbox is busy for minutes
// and idle for hours, and the idle hours are supposed to cost nothing. This backend had no such
// thing — every container ever started stayed up, capped at 2 GiB each, `unless-stopped` so they
// even came back after a daemon restart. A self-hosted box fills up and dies.
//
// Containers are *stopped*, not removed: the project volume survives, so waking one is a start
// and `ensureContainer` already does that on the next call.
const SLEEP_AFTER_MS = parseDuration(process.env.SANDBOX_SLEEP_AFTER ?? '5m')
// Finer than the window it enforces, or the window is a suggestion: sweeping every minute would
// have let a thirty-second idle live for ninety.
const SWEEP_EVERY_MS = 10_000

/** "5m", "90s", "1h", or a plain number of seconds. */
function parseDuration(v: string): number {
  const m = /^(\d+)\s*([smh]?)$/.exec(v.trim())
  if (!m) return 5 * 60_000
  const n = Number(m[1])
  return n * (m[2] === 'h' ? 3_600_000 : m[2] === 'm' ? 60_000 : 1000)
}

/** Last time the API touched an app, and the last network counter we saw for it. */
const lastTouch = new Map<string, number>()
const lastRx = new Map<string, number>()
const touch = (id: string) => lastTouch.set(id, Date.now())

/** Bytes this container has received, across every network it is on. */
async function rxBytes(c: Docker.Container): Promise<number> {
  try {
    const s: any = await c.stats({ stream: false })
    return Object.values(s?.networks ?? {}).reduce((t: number, n: any) => t + (n?.rx_bytes ?? 0), 0)
  } catch { return 0 }
}

/**
 * Stop what nobody is using.
 *
 * Two signals, because neither alone is enough: the API tells us about agent work, but a person
 * watching a preview talks to the container's published port directly and never reaches this
 * process at all. Reaping on API activity alone would pull the page out from under them.
 */
async function sweep() {
  const running = await docker.listContainers({ filters: { label: ['lovbase.app'] } }).catch(() => [])
  const now = Date.now()
  for (const info of running) {
    const id = info.Labels?.['lovbase.app']
    if (!id) continue
    const c = docker.getContainer(info.Id)

    const rx = await rxBytes(c)
    const prevRx = lastRx.get(id)
    lastRx.set(id, rx)
    // Traffic since the last sweep means someone is looking at the preview right now.
    if (prevRx !== undefined && rx > prevRx) { touch(id); continue }

    const seen = lastTouch.get(id)
    // First sight (a fresh runner process, containers left from before): start its clock rather
    // than reaping something that may well be in use.
    if (seen === undefined) { touch(id); continue }
    if (now - seen < SLEEP_AFTER_MS) continue

    try {
      await c.stop({ t: 5 })
      lastTouch.delete(id); lastRx.delete(id)
      console.log(`slept ${nameFor(id)} after ${Math.round((now - seen) / 1000)}s idle`)
    } catch { /* already gone, or stopping; the next sweep sorts it out */ }
  }
}

async function ensureContainer(id: string): Promise<Docker.Container> {
  touch(id)
  const name = nameFor(id)
  const existing = docker.getContainer(name)
  try {
    const info = await existing.inspect()
    if (!info.State.Running) await existing.start()
    return existing
  } catch {}
  const c = await docker.createContainer({
    name, Image: IMAGE, Cmd: ['sleep', 'infinity'], Tty: false,
    ExposedPorts: { '5173/tcp': {} },
    HostConfig: {
      Binds: [`${name}:/workspace`],
      PortBindings: { '5173/tcp': [{ HostPort: '' }] },      // random host port
      ExtraHosts: ['host.docker.internal:host-gateway'],
      Memory: 2 * 1024 ** 3, NanoCpus: 1_000_000_000, PidsLimit: 512,
      RestartPolicy: { Name: 'unless-stopped' },
    },
    Labels: { 'lovbase.app': id },
  })
  await c.start()
  return c
}

/** Run a command to completion; returns exit code + output. */
async function exec(c: Docker.Container, cmd: string[], opts: { env?: string[]; cwd?: string; timeoutMs?: number } = {}) {
  const e = await c.exec({ Cmd: cmd, Env: opts.env, WorkingDir: opts.cwd, AttachStdout: true, AttachStderr: true })
  const stream = await e.start({})
  let stdout = '', stderr = ''
  const out = { write: (b: Buffer) => { stdout += b.toString() }, end() {} } as any
  const err = { write: (b: Buffer) => { stderr += b.toString() }, end() {} } as any
  docker.modem.demuxStream(stream, out, err)
  await new Promise<void>((resolve, reject) => {
    const timer = opts.timeoutMs ? setTimeout(() => { stream.destroy(); reject(new Error('timeout')) }, opts.timeoutMs) : null
    stream.on('end', () => { if (timer) clearTimeout(timer); resolve() })
    stream.on('error', reject)
  })
  const { ExitCode } = await e.inspect()
  return { success: ExitCode === 0, stdout, stderr }
}

/** The runner's own env is the container env: the Docker backend has nothing like setEnvVars. */
const baseEnv = () =>
  PROXY ? [`HTTPS_PROXY=${PROXY}`, `HTTP_PROXY=${PROXY}`, 'NO_PROXY=host.docker.internal,localhost,127.0.0.1'] : []

function dockerBackend(id: string): SandboxBackend {
  const container = () => ensureContainer(id)
  const sh = async (script: string, o?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) =>
    exec(await container(), ['sh', '-lc', script], {
      cwd: o?.cwd, timeoutMs: o?.timeoutMs,
      env: [...baseEnv(), ...Object.entries(o?.env ?? {}).map(([k, v]) => `${k}=${v}`)],
    })
  return {
    exec: sh,
    exists: async (p) => (await sh(`test -e ${q(p)} && echo yes || echo no`)).stdout.trim() === 'yes',
    async readFile(p) {
      const r = await exec(await container(), ['cat', p])
      if (!r.success) throw new Error(r.stderr || 'not found')
      return r.stdout
    },
    async writeFile(p, content) {
      // Content travels as an env var (fine for source files); path is a positional arg, so no quoting games.
      const r = await exec(await container(), ['sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$CONTENT" > "$1"', 'sh', p], { env: [`CONTENT=${content}`] })
      if (!r.success) throw new Error(r.stderr)
    },
    async listFiles(dir) {
      const r = await sh(`cd ${q(dir)} 2>/dev/null && find . -type f -printf '%P %s\\n' | grep -v '^$' || true`)
      return r.stdout.trim().split('\n').filter(Boolean).map((l) => { const i = l.lastIndexOf(' '); return { path: l.slice(0, i), size: Number(l.slice(i + 1)) } })
    },
    async preview() {
      const c = await container()
      // Bracket one character so pgrep does not match the shell command running this check.
      const running = await sh(`pgrep -f "vite --hos[t]" >/dev/null && echo yes || echo no`)
      if (running.stdout.trim() !== 'yes') await sh(`cd ${APP} && (nohup bun run dev > /tmp/vite.log 2>&1 &)`)
      const info = await c.inspect()
      const hostPort = info.NetworkSettings.Ports['5173/tcp']?.[0]?.HostPort
      const url = `http://${PREVIEW_HOST}:${hostPort}/`
      for (let i = 0; i < 60; i++) {
        try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.ok) return { previewUrl: url } } catch {}
        await new Promise((r) => setTimeout(r, 500))
      }
      const log = await sh('tail -c 2000 /tmp/vite.log')
      throw new Error('vite did not come up: ' + log.stdout)
    },
    async logs() {
      // Bracketed so pgrep does not match the shell running this very line and call a dead dev
      // server running.
      const r = await sh('tail -c 4000 /tmp/vite.log 2>/dev/null; pgrep -f "vite --hos[t]" >/dev/null && echo __RUNNING__')
      return { running: r.stdout.includes('__RUNNING__'), stdout: r.stdout.replace('__RUNNING__', '').trim() }
    },
    async stop() {
      // Stopped, not removed: the filesystem is what makes starting it again cheap.
      try { await docker.getContainer(nameFor(id)).stop() } catch { /* not running */ }
    },
    async destroy() {
      await docker.getContainer(nameFor(id)).remove({ force: true, v: true })
    },
  }
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

const app = new Hono<{ Variables: { sandbox: SandboxCtx } }>()
  .use('*', async (c, next) => {
    c.set('sandbox', {
      token: TOKEN,
      config: { apiUrl: API_URL, publicApiUrl: PUBLIC_API_URL, httpProxy: PROXY || undefined },
      backend: (id) => dockerBackend(id),   // no static store: publishing is the Worker backend's job
    })
    await next()
  })
  .route('/', sandboxApi)
  .notFound(notFound)
  .onError(onError)

setInterval(() => { void sweep() }, SWEEP_EVERY_MS)

Bun.serve({ port: PORT, idleTimeout: 255, fetch: app.fetch })
console.log(`sandbox-runner on :${PORT} (image ${IMAGE}, docker ${process.env.DOCKER_HOST ?? 'socket'}, sleep after ${SLEEP_AFTER_MS / 1000}s idle)`)
