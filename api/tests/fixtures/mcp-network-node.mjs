import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const { mcpFetch } = await import(pathToFileURL(process.env.MCP_NETWORK_MODULE).href)

// Real sockets reproduce the Node toWeb cancellation race; Readable.from mocks do not.
async function fixture(handler, run, { timeout = 1000, maxBytes = 128000 } = {}) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const fetch = mcpFetch(timeout, maxBytes, {
    resolve: async raw => ({ url: new URL(raw), address: { address: '93.184.215.14', family: 4 } }),
    request: (_url, options, callback) => request({
      ...options, host: '127.0.0.1', port: server.address().port, path: '/', lookup: undefined,
    }, callback),
  })
  try { await run(fetch) }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}

test('immediate cancellation of buffered 401 and 405 responses does not crash Node', async () => {
  for (const status of [401, 405]) {
    await fixture((_req, res) => { res.writeHead(status); res.end('response body') }, async fetch => {
      for (let i = 0; i < 10; i++) {
        const response = await fetch('https://mcp.example.test')
        await response.body.cancel()
      }
    })
  }
})

test('SDK initializes, discovers and calls SSE tools despite unsupported GET', async () => {
  let gets = 0
  await fixture(async (req, res) => {
    if (req.method === 'GET') { gets++; res.writeHead(405); res.end('GET not supported'); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (!('id' in body)) { res.writeHead(202); res.end(); return }
    const result = body.method === 'initialize'
      ? { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
      : body.method === 'tools/list'
        ? { tools: [{ name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
        : { content: [{ type: 'text', text: 'read succeeded' }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`)
  }, async fetch => {
    const client = new Client({ name: 'test', version: '1' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('https://mcp.example.test'), { fetch }))
      assert.equal((await client.listTools()).tools[0].name, 'read')
      assert.equal((await client.callTool({ name: 'read', arguments: {} })).content[0].text, 'read succeeded')
      assert.ok(gets > 0)
    } finally { await client.close() }
  })
})

test('cancelling an ongoing response closes its socket', async () => {
  let closed
  await fixture((_req, res) => {
    closed = once(res, 'close')
    res.writeHead(200); res.write('first chunk')
  }, async fetch => {
    const response = await fetch('https://mcp.example.test')
    const reader = response.body.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'first chunk')
    await reader.cancel()
    await closed
  })
})

test('timeouts reject pending reads and release the response socket', async () => {
  let closed
  await fixture((_req, res) => {
    closed = once(res, 'close')
    res.writeHead(200); res.write('partial')
  }, async fetch => {
    const response = await fetch('https://mcp.example.test')
    await assert.rejects(response.text(), /timeout|abort/i)
    await closed
  }, { timeout: 80 })
})

test('oversized and truncated responses reject without uncaught stream errors', async () => {
  await fixture((_req, res) => { res.end('x'.repeat(100)) }, async fetch => {
    const response = await fetch('https://mcp.example.test')
    await assert.rejects(response.text(), /too large/)
  }, { maxBytes: 32 })
  await fixture((_req, res) => {
    res.writeHead(200, { 'content-length': '100' }); res.write('partial')
    setImmediate(() => res.destroy())
  }, async fetch => {
    const response = await fetch('https://mcp.example.test')
    await assert.rejects(response.text())
  })
})

test('no-content responses have no stream and redirects remain blocked', async () => {
  await fixture((_req, res) => { res.writeHead(204); res.end() }, async fetch => {
    const response = await fetch('https://mcp.example.test')
    assert.equal(response.body, null)
  })
  await fixture((_req, res) => { res.writeHead(302, { location: 'https://127.0.0.1' }); res.end() }, async fetch => {
    await assert.rejects(fetch('https://mcp.example.test'), /redirects are not allowed/)
  })
})
