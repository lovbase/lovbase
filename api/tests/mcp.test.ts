import { describe, expect, test } from 'bun:test'
import { dedupeMcpRegistryEntries, safeMcpUrl } from '../src/modules/integrations/mcp.service'

describe('MCP endpoint validation', () => {
  test('accepts HTTPS and rejects insecure or local endpoints', () => {
    expect(safeMcpUrl('https://registry.example.com/v0/servers').hostname).toBe('registry.example.com')
    for (const url of ['http://registry.example.com', 'https://localhost/v0/servers', 'https://127.0.0.1/mcp', 'https://10.0.0.2/mcp', 'https://192.168.1.4/mcp']) {
      expect(() => safeMcpUrl(url)).toThrow()
    }
  })

  test('rejects malformed and reserved network addresses', () => {
    for (const url of ['not-a-url', 'https://0.0.0.0/mcp', 'https://224.0.0.1/mcp', 'https://service.local/mcp', 'https://[fd00::1]/mcp', 'https://[fe80::1]/mcp']) {
      expect(() => safeMcpUrl(url)).toThrow()
    }
  })

  test('deduplicates registry records by server identifier', () => {
    const entries = dedupeMcpRegistryEntries([
      { server: { name: 'example/server', title: 'Old', version: '1.0.0' }, _meta: { official: { isLatest: false } } },
      { server: { name: 'example/server', title: 'Latest', version: '2.0.0', remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }] }, _meta: { official: { isLatest: true } } },
      { server: { name: 'another/server', title: 'Another' } },
    ])

    expect(entries).toHaveLength(2)
    expect(entries.find((entry) => entry.remoteId === 'example/server')?.server.title).toBe('Latest')
  })
})

describe('MCP network boundaries', () => {
  test('blocks metadata services, IPv4-mapped IPv6, reserved and credential-bearing URLs', () => {
    for (const url of ['https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/mcp', 'https://198.18.0.1', 'https://[::ffff:127.0.0.1]', 'https://[::ffff:a9fe:a9fe]', 'https://[2001:db8::1]', 'https://localhost./mcp', 'https://user:secret@example.com', 'https://example.com/#secret']) expect(() => safeMcpUrl(url)).toThrow()
    expect(safeMcpUrl('https://[2606:4700:4700::1111]/mcp').protocol).toBe('https:')
  })
})
