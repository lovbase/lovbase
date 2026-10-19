import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('MCP transport survives real socket cancellation in the Node production runtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lovbase-mcp-node-'))
  try {
    const built = await Bun.build({
      entrypoints: [new URL('../src/modules/integrations/mcp-network.ts', import.meta.url).pathname],
      outdir: dir, target: 'node', naming: 'network.mjs',
    })
    expect(built.success).toBe(true)
    const child = Bun.spawn([process.env.MCP_TEST_NODE ?? 'node', '--test', new URL('./fixtures/mcp-network-node.mjs', import.meta.url).pathname], {
      env: { ...process.env, MCP_NETWORK_MODULE: join(dir, 'network.mjs') }, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ code, diagnostics: code ? stdout + stderr : '' }).toEqual({ code: 0, diagnostics: '' })
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 15_000)
