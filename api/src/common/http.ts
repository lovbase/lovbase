import type { Request, Response } from 'express'
import { Readable } from 'node:stream'
import { DomainError } from './errors'

// The handlers here were fetch handlers before they were controllers, and several of them need the
// body exactly as it arrived (Stripe signs the raw bytes; Better Auth parses it itself). The Nest
// app therefore runs with `bodyParser: false` and these two helpers bridge Express and fetch.

/** Absolute URL of the request, honouring the proxy headers Railway and Cloudflare set. */
export function requestUrl(req: Request): URL {
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] ?? req.protocol ?? 'http'
  const host = (req.headers['x-forwarded-host'] as string)?.split(',')[0] ?? req.headers.host ?? 'localhost'
  return new URL(req.originalUrl, `${proto}://${host}`)
}

export function requestHeaders(req: Request): Headers {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const one of v) headers.append(k, one)
    else if (typeof v === 'string') headers.set(k, v)
  }
  return headers
}

/** Buffer the raw body. Bodies here are small (JSON payloads, webhooks), so this never streams. */
export async function rawBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export async function toFetchRequest(req: Request): Promise<Request_> {
  const method = req.method.toUpperCase()
  const body = method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await rawBody(req))
  return new Request(requestUrl(req), { method, headers: requestHeaders(req), body })
}
type Request_ = globalThis.Request

/** Write a fetch Response onto the Express response, preserving multiple Set-Cookie headers. */
export function sendFetchResponse(res: Response, out: globalThis.Response) {
  for (const [k, v] of out.headers) if (k.toLowerCase() !== 'set-cookie') res.setHeader(k, v)
  const cookies = out.headers.getSetCookie?.() ?? []
  if (cookies.length) res.setHeader('set-cookie', cookies)
  res.status(out.status)
  if (!out.body) return void res.end()
  Readable.fromWeb(out.body as any).pipe(res)
}

/** JSON with a fixed header set (the data API's CORS, for instance). */
export function sendJson(res: Response, body: unknown, status = 200, headers: Record<string, string> = {}) {
  res.status(status).set({ 'Content-Type': 'application/json', ...headers }).send(JSON.stringify(body))
}

/** Parse a JSON body, answering with the caller-facing message when it is not JSON. */
export async function jsonBody<T>(req: Request, onError: string): Promise<T> {
  const raw = (await rawBody(req)).toString('utf8')
  try { return JSON.parse(raw) as T } catch { throw new BadJson(onError) }
}

export class BadJson extends DomainError {
  readonly status = 400
}
