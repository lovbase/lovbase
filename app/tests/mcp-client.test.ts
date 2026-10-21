import { expect, test } from 'bun:test'
import { safeReturnTo } from '../src/lib/return-to'
import { mcpClientConfig } from '../src/lib/mcp-client-config'
import { authReturn, authSearch } from '../src/lib/auth-return'
test('login preserves template remix and MCP consent destinations together',() => {
  const consent = `/mcp/authorize?request=${'a'.repeat(43)}`
  expect(authReturn('/templates?template=inventory')).toBe('/templates?template=inventory&remix=1')
  expect(authSearch({returnTo:consent,error:'denied'})).toEqual({returnTo:consent,error:'denied'})
  for (const value of ['https://evil.test','//evil.test','/mcp/authorize?request=bad','/api/auth/sign-out'])
    expect(authReturn(value)).toBeUndefined()
})
test('login return URLs cannot escape the current origin',() => {
  for (const value of ['https://evil.test','//evil.test','/\\evil.test','/\nevil.test',null]) expect(safeReturnTo(value)).toBe('/home')
  expect(safeReturnTo('/mcp/authorize?request=abc')).toBe('/mcp/authorize?request=abc')
})
test('client configuration uses the installation URL and client-specific keys',() => {
  const config = mcpClientConfig('https://lovbase.test/mcp')
  expect(config.claude).toBe('claude mcp add --transport http lovbase https://lovbase.test/mcp')
  expect(config.codex).toBe('codex mcp add lovbase --url https://lovbase.test/mcp')
  expect(config.login).toBe('codex mcp login lovbase')
  expect(JSON.parse(config.json).mcpServers.lovbase.url).toBe('https://lovbase.test/mcp')
  expect(JSON.parse(config.vscode).servers.lovbase.type).toBe('http')
  expect(mcpClientConfig('https://test/mcp?x=$(whoami)').codex).toContain("'https://test/mcp?x=$(whoami)'")
})
