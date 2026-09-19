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
const API_URL = process.env.LOVBASE_API_URL ?? 'http://host.docker.internal:3000'      // seen from inside containers
const PUBLIC_API_URL = process.env.LOVBASE_PUBLIC_API_URL ?? 'http://localhost:3000'   // seen from the viewer's browser
const PREVIEW_HOST = process.env.PREVIEW_HOST ?? 'localhost'                           // where published ports are reachable
const PROXY = process.env.SANDBOX_HTTP_PROXY ?? ''

const nameFor = (id: string) => `lovbase-app-${id}`

async function ensureContainer(id: string): Promise<Docker.Container> {
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
      const running = await sh(`pgrep -f "vite --host" >/dev/null && echo yes || echo no`)
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
      const r = await sh('tail -c 4000 /tmp/vite.log 2>/dev/null; pgrep -f "vite --host" >/dev/null && echo __RUNNING__')
      return { running: r.stdout.includes('__RUNNING__'), stdout: r.stdout.replace('__RUNNING__', '').trim() }
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

Bun.serve({ port: PORT, idleTimeout: 255, fetch: app.fetch })
console.log(`sandbox-runner on :${PORT} (image ${IMAGE}, docker ${process.env.DOCKER_HOST ?? 'socket'})`)
