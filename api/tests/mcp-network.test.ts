import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { request } from 'node:https'
import { isPublicMcpAddress, mcpFetch, resolveMcpUrl, safeMcpUrl } from '../src/modules/integrations/mcp-network'

function fixture(status: number, body = '', headers: Record<string, string> = {}) {
  let options: any
  let closed = false
  const mockRequest = ((_url: URL, opts: any, callback: Function) => {
    options = opts
    const outgoing = new EventEmitter() as any
    outgoing.end = () => {
      const incoming = Object.assign(Readable.from([Buffer.from(body)]), { statusCode: status, headers })
      incoming.on('close', () => { closed = true })
      callback(incoming)
    }
    return outgoing
  }) as unknown as typeof request
  const dependencies = { request: mockRequest, resolve: async (url: string) => ({ url: safeMcpUrl(url), address: { address: '93.184.215.14', family: 4 } }) }
  return { fetch: mcpFetch(1000, 32, dependencies), options: () => options, closed: () => closed }
}

describe('MCP HTTP transport', () => {
  test('pins the validated DNS answer, including all-address lookup, and preserves explicit authentication', async () => {
    const f = fixture(200, '{"ok":true}', { 'content-type': 'application/json' })
    const response = await f.fetch('https://mcp.example.com', { method: 'POST', headers: { authorization: 'Bearer test-only' }, body: '{}' })
    expect(await response.json()).toEqual({ ok: true })
    const options = f.options()
    expect(options.headers.authorization).toBe('Bearer test-only')
    expect(options.agent).toBe(false)
    let single: unknown[], all: unknown[]
    options.lookup('mcp.example.com', {}, (...args: unknown[]) => { single = args })
    options.lookup('mcp.example.com', { all: true }, (...args: unknown[]) => { all = args })
    expect(single!).toEqual([null, '93.184.215.14', 4])
    expect(all!).toEqual([null, [{ address: '93.184.215.14', family: 4 }]])
  })

  test('rejects redirects before consuming a response, including same-origin redirects', async () => {
    for (const location of ['https://127.0.0.1/private', 'https://mcp.example.com/other']) {
      const f = fixture(302, '', { location })
      await expect(f.fetch('https://mcp.example.com')).rejects.toThrow('redirects are not allowed')
    }
  })

  test('bounds streamed results and closes the source', async () => {
    const f = fixture(200, 'x'.repeat(100))
    const response = await f.fetch('https://mcp.example.com')
    await expect(response.text()).rejects.toThrow('too large')
    expect(f.closed()).toBe(true)
  })

  test('blocks non-public address families and aborted DNS operations', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '100.64.0.1', '192.168.1.1', '::1', '::ffff:7f00:1', 'fd00::1', '2001:db8::1', '2002:7f00:1::']) expect(isPublicMcpAddress(address)).toBe(false)
    expect(isPublicMcpAddress('8.8.8.8')).toBe(true)
    const controller = new AbortController(); controller.abort()
    await expect(resolveMcpUrl('https://mcp.example.com', controller.signal)).rejects.toThrow()
  })
})
