// What the sandbox API needs from wherever a generated app actually runs. Two implementations:
// a Cloudflare Sandbox (src/index.ts, production) and a plain Docker container (runner/, local
// and self-hosted). Everything above this line is shared (src/app.ts).

export type ExecResult = { success: boolean; stdout: string; stderr: string }
export type ExecOptions = { cwd?: string; env?: Record<string, string>; timeoutMs?: number }

export interface SandboxBackend {
  /** Run a shell script (`sh -lc`) to completion. Never throws on a non-zero exit; check `success`. */
  exec(script: string, opts?: ExecOptions): Promise<ExecResult>
  exists(path: string): Promise<boolean>
  /** Throws when the file is missing. */
  readFile(path: string): Promise<string>
  /** Creates parent directories. Text only. */
  writeFile(path: string, content: string): Promise<void>
  /** Regular files under `dir`, recursive, paths relative to `dir`. Hidden files included. */
  listFiles(dir: string): Promise<{ path: string; size: number }[]>
  /** Make sure `vite dev` is up and return where the viewer's browser reaches it. */
  preview(): Promise<{ previewUrl: string }>
  logs(): Promise<{ running: boolean; stdout?: string; stderr?: string }>
  /** Environment for processes the backend starts on its own (the dev server). Optional. */
  setEnv?(vars: Record<string, string>): Promise<void>
  /** Stop everything and drop the project. The next request starts from a clean template. */
  destroy(): Promise<void>
}

/** Object storage for published apps. Only the Cloudflare backend has one (R2). */
export interface StaticStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  /** Returns how many objects were removed. */
  deletePrefix(prefix: string): Promise<number>
}

export type SandboxConfig = {
  /** Lovbase data API as seen from INSIDE the container (the `lovbase` CLI pi uses). */
  apiUrl: string
  /** ...and as seen from the viewer's browser (baked into the generated Vite app). */
  publicApiUrl: string
  /** Egress proxy for the agent's LLM traffic. Dev only. */
  httpProxy?: string
}

/** Everything a request needs, set by the host (Worker or runner) before routing into the shared API. */
export type SandboxCtx = {
  token: string
  config: SandboxConfig
  store?: StaticStore
  backend: (appId: string, hostname: string) => SandboxBackend
}

export const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff',
  ttf: 'font/ttf', map: 'application/json', txt: 'text/plain; charset=utf-8', webmanifest: 'application/manifest+json',
}
export const mimeFor = (path: string) => MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/** Single-quote a string for `sh -c`. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
