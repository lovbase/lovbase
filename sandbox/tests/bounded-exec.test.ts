import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundedExecScript } from '../src/bounded-exec'
import { shq } from '../src/backend'

test('container watchdog kills child and grandchild processes before returning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lovbase-watchdog-'))
  const marker = join(dir, 'late-write')
  try {
    const grandchild = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),600)`
    const script = `sh -c ${shq(`bun -e ${shq(grandchild)} & wait`)} & wait`
    const child = Bun.spawn(['sh', '-c', boundedExecScript(script, 100)], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(124)
    await Bun.sleep(700)
    await expect(readFile(marker, 'utf8')).rejects.toThrow()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('watchdog preserves ordinary command success and failures', async () => {
  for (const exit of [0, 7]) {
    const child = Bun.spawn(['sh', '-c', boundedExecScript(`exit ${exit}`, 5_000)], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(exit)
  }
})
