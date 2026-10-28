import { expect, test } from 'bun:test'
import { appFileTools, applySourceEdits, readSourceSlice } from '../src/modules/agent/app-file-tools'

function fixture() {
  let source = new Map([['src/a.ts', 'const color = "red";\nconst link = "old";'], ['src/b.ts', 'const size = 1;']])
  let saved = new Map(source)
  const writes: string[] = []
  const commands: string[] = []
  const tools = appFileTools({
    appId: 'a', ensureSource: async () => {},
    sandbox: {
      readFile: async (_: string, path: string) => {
        if (!source.has(path)) throw new Error('not found')
        return { path, content: source.get(path)! }
      },
      writeFile: async (_: string, path: string, content: string) => { writes.push(path); source.set(path, content); return { ok: true, path } },
      exec: async (_: string, command: string) => { commands.push(command); return { ok: true, stdout: 'passed', stderr: '' } },
    } as any,
    persist: async () => { saved = new Map(source) },
  })
  return { tools, writes, commands, source: () => source, restore: () => { source = new Map(saved) } }
}
const execute = (tool: any, input: any) => tool.execute(input, { toolCallId: 't', messages: [] })

test('line reads and continuation reconstruct long lines and CRLF without losing characters', () => {
  const content = 'header\r\n' + '中'.repeat(14001) + '\r\nfooter'
  let input: any = { path: 'src/a.ts', startLine: 2, endLine: 3 }
  let reconstructed = ''
  do {
    const result = readSourceSlice(content, input)
    expect(result.content.length).toBeLessThanOrEqual(6000)
    reconstructed += result.content
    input = result.next
  } while (input)
  expect(reconstructed).toBe(content.split('\n').slice(1).join('\n'))
  expect(readSourceSlice('a\nb\nc', { path: 'a', startLine: 2, endLine: 2 })).toMatchObject({ content: 'b', hasMoreLines: true, next: null })
  expect(() => readSourceSlice('a', { path: 'a', startLine: 3 })).toThrow('outside')
  expect(() => readSourceSlice('a\nb', { path: 'a', startLine: 2, endLine: 1 })).toThrow('endLine')
})

test('a file is validated fully before writing; other batch files can succeed and survive restore', async () => {
  const f = fixture()
  const result = await execute(f.tools.edit_app_files, { files: [
    { path: 'src/a.ts', edits: [{ find: '"red"', replace: '"blue"' }, { find: 'missing', replace: 'bad' }] },
    { path: 'src/b.ts', edits: [{ find: '= 1', replace: '= 2' }, { find: 'size', replace: 'count' }] },
  ] })
  expect(result.ok).toBe(false)
  expect(result.files[0].error).toContain('not found')
  expect(result.files[1].ok).toBe(true)
  expect(f.writes).toEqual(['src/b.ts'])
  f.restore()
  expect(f.source().get('src/a.ts')).toContain('"red"')
  expect(f.source().get('src/b.ts')).toBe('const count = 2;')
})

test('unique replacements include overlapping matches and preserve literal replacement text', () => {
  expect(() => applySourceEdits('aaa', [{ find: 'aa', replace: 'x' }])).toThrow('not unique')
  expect(applySourceEdits('old', [{ find: 'old', replace: '$& $1' }])).toBe('$& $1')
})

test('protected paths and traversal cannot be written through old or new tools', async () => {
  const f = fixture()
  for (const path of ['../secret', '/tmp/file', 'src/../index.html', '.env', 'AGENTS.md', 'src/lib/lovbase.ts', 'vite.config.ts']) {
    expect((await execute(f.tools.write_app_file, { path, content: 'bad' })).ok).toBe(false)
    expect((await execute(f.tools.edit_app_file, { path, find: 'a', replace: 'b' })).ok).toBe(false)
  }
  expect(f.writes).toHaveLength(0)
})

test('batch reads cap content at 24000 characters and preserve per-file failures', async () => {
  const f = fixture()
  f.source().set('src/long.ts', 'x'.repeat(20000))
  const result = await execute(f.tools.read_app_files, { files: Array.from({ length: 4 }, () => ({ path: 'src/long.ts' })) })
  expect(result.files.reduce((n: number, file: any) => n + file.content.length, 0)).toBe(24000)
  expect(result.files.every((file: any) => file.truncated && file.next.startColumn === 6001)).toBe(true)
  const missing = await execute(f.tools.read_app_files, { files: [{ path: 'missing.ts' }, { path: 'src/a.ts' }] })
  expect(missing.files[0].error).toBe('not found')
  expect(missing.files[1].content).toContain('red')
})

test('final batch formats and checks once; simultaneous legacy edits cannot lose writes', async () => {
  const f = fixture()
  await Promise.all([
    execute(f.tools.edit_app_file, { path: 'src/a.ts', find: '"red"', replace: '"blue"' }),
    execute(f.tools.edit_app_file, { path: 'src/a.ts', find: '"old"', replace: '"new"' }),
  ])
  expect(f.source().get('src/a.ts')).toContain('"blue"')
  expect(f.source().get('src/a.ts')).toContain('"new"')
  const result = await execute(f.tools.edit_app_files, { files: [
    { path: 'src/b.ts', edits: [{ find: '= 1', replace: '= 3' }] },
  ], check: 'format-and-typecheck' })
  expect(result.ok).toBe(true)
  expect(result.checks).toHaveLength(2)
  expect(f.commands).toEqual(['bun run format', 'bun run typecheck'])
})
