import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { DomainError } from '../../common/errors'

export function isPublicMcpAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (isIP(host) === 4) {
    const [a, b, c] = host.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  // Only global unicast IPv6; exclude transition and documentation prefixes.
  return isIP(host) === 6 && /^[23]/.test(host) && !/^2001:(?:0:|db8:|2:|10:|20:)/.test(host) && !host.startsWith('2002:') && !host.startsWith('3fff:')
}

export function safeMcpUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new DomainError('MCP URL is invalid.') }
  if (url.protocol !== 'https:') throw new DomainError('MCP URLs must use HTTPS.')
  if (url.username || url.password || url.hash) throw new DomainError('MCP URLs must not contain credentials or fragments.')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') && !isIP(host)
    || isIP(host) && !isPublicMcpAddress(host)) throw new DomainError('Local or reserved MCP endpoints are not allowed.')
  return url
}

export async function resolveMcpUrl(raw: string, signal?: AbortSignal) {
  const url = safeMcpUrl(raw)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let onAbort: (() => void) | undefined
  let addresses: Array<{ address: string; family: number }>
  try {
    signal?.throwIfAborted()
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        if (signal) { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }) }
      }),
    ])
  } finally { if (signal && onAbort) signal.removeEventListener('abort', onAbort) }
  if (!addresses.length || addresses.some(a => !isPublicMcpAddress(a.address))) throw new DomainError('Local or reserved MCP endpoints are not allowed.')
  return { url, address: addresses[0]! }
}

/** Pin the verified DNS answer to the actual TLS socket. Never follow redirects or use ambient cookies. */
export function mcpFetch(timeoutMs: number, maxBytes: number, dependencies = { resolve: resolveMcpUrl, request }): FetchLike {
  return async (input, init) => {
    const req = new Request(input, init)
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)])
    const { url, address } = await dependencies.resolve(req.url, signal)
    signal.throwIfAborted()
    const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined
    return new Promise<Response>((resolve, reject) => {
      const outgoing = dependencies.request(url, {
        method: req.method, headers: Object.fromEntries(req.headers), signal, agent: false,
        lookup: ((_host: string, options: { all?: boolean }, callback: Function) => options.all
          ? callback(null, [address]) : callback(null, address.address, address.family)) as any,
      }, incoming => {
        const status = incoming.statusCode ?? 502
        if (status >= 300 && status < 400 && status !== 304) {
          incoming.destroy(); reject(new DomainError('MCP redirects are not allowed. Use the final server URL.')); return
        }
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        const noBody = req.method === 'HEAD' || [204, 205, 304].includes(status)
        if (noBody) {
          incoming.destroy()
          resolve(new Response(null, { status, headers }))
          return
        }
        // The SDK cancels unused 401/405 responses immediately. Node's toWeb adapter
        // can enqueue already-buffered data after cancellation and crash the process.
        // Own the lifecycle so cancellation, abort and late socket events settle once.
        let settled = false
        let bytes = 0
        let onAbort: () => void
        const cleanup = () => {
          settled = true
          signal.removeEventListener('abort', onAbort)
          incoming.destroy()
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const fail = (error: unknown) => {
              if (settled) return
              cleanup()
              controller.error(error)
            }
            onAbort = () => fail(signal.reason)
            incoming.on('data', (chunk: Buffer) => {
              if (settled) return
              bytes += chunk.length
              if (bytes > maxBytes) { fail(new DomainError('MCP response is too large.')); return }
              controller.enqueue(chunk)
              if ((controller.desiredSize ?? 0) <= 0) incoming.pause()
            })
            incoming.on('end', () => {
              if (settled) return
              cleanup()
              controller.close()
            })
            incoming.on('error', fail)
            incoming.on('close', () => {
              if (!settled) fail(new DomainError('MCP response closed before completion.'))
            })
            incoming.pause()
            signal.addEventListener('abort', onAbort, { once: true })
            if (signal.aborted) onAbort()
          },
          pull() { if (!settled) incoming.resume() },
          cancel() { if (!settled) cleanup() },
        })
        resolve(new Response(stream, { status, headers }))
      })
      outgoing.on('error', reject)
      outgoing.end(body)
    })
  }
}
