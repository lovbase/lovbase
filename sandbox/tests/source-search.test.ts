import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SOURCE_SEARCH_SCRIPT, type SourceSearchInput, type SourceSearchResult } from '../src/source-search'

const root = await mkdtemp(join(tmpdir(), 'lovbase-search-'))
afterAll(() => rm(root, { recursive: true, force: true }))
async function search(input: Partial<SourceSearchInput>): Promise<SourceSearchResult> {
  const proc = Bun.spawn([process.execPath, '-e', SOURCE_SEARCH_SCRIPT, root, JSON.stringify({ query: 'needle', pathPrefix: '', fileOffset: 0, startLine: 1, ...input })], { stdout: 'pipe', stderr: 'pipe' })
  const [output, error, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (exit) throw new Error(error)
  return JSON.parse(output)
}

test('literal search stays in source, ignores secrets/symlinks/bundles and paginates repeated matches', async () => {
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'node_modules'))
  await writeFile(join(root, 'src/page.ts'), Array.from({ length: 25 }, (_, i) => `needle ${i + 1}`).join('\n'))
  await writeFile(join(root, '.env'), 'needle secret')
  await writeFile(join(root, 'node_modules/pkg.js'), 'needle dependency')
  await writeFile(join(root, 'bundle.min.js'), 'needle bundle')
  await writeFile(join(root, 'AGENTS.md'), 'needle instructions')
  await writeFile(join(root, 'src/large.js'), 'needle'.repeat(100000))
  await symlink(join(root, '.env'), join(root, 'src/leak.ts'))
  const first = await search({})
  expect(first.matches).toHaveLength(20)
  expect(first.matches.every(match => match.path === 'src/page.ts')).toBe(true)
  const second = await search(first.next!)
  expect(second.matches.map(match => match.line)).toEqual([21, 22, 23, 24, 25])
  expect(second.next).toBeNull()
  expect((await search({ query: 'absent' })).matches).toEqual([])
  expect((await search({ query: '$(touch /tmp/never-run)' })).matches).toEqual([])
  expect((await search({ pathPrefix: 'src/page.ts' })).matches[0]).toMatchObject({ line: 1, text: 'needle 1', after: 'needle 2' })
})
