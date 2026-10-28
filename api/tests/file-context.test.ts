import { expect, test } from 'bun:test'
import { convertToModelMessages, type UIMessage } from 'ai'
import { compactFileContext } from '../src/modules/agent/file-context'

const readPart = { type: 'tool-read_app_file', state: 'output-available', toolCallId: 'read', input: { path: 'a.ts' }, output: { path: 'a.ts', content: 'old code'.repeat(10000) } }
const history = (parts: any[]): UIMessage[] => [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Keep accessible keyboard navigation.' }] },
  { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Updated a.ts' }, ...parts] },
  { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Now make the heading blue.' }] },
  { id: 'a2', role: 'assistant', parts: [{ ...readPart, toolCallId: 'current' } as any] },
]

test('model projection trims completed payloads without mutating transcript or current work', async () => {
  const messages = history([readPart, { type: 'tool-edit_app_file', state: 'output-available', toolCallId: 'edit', input: { path: 'a.ts', find: 'x'.repeat(12000), replace: 'y'.repeat(12000) }, output: { ok: true, path: 'a.ts' } }])
  const before = JSON.stringify(messages)
  const result = compactFileContext(messages)
  expect(JSON.stringify(messages)).toBe(before)
  expect(result[0]).toEqual(messages[0])
  expect(result[2]).toEqual(messages[2])
  expect(result[3]).toEqual(messages[3])
  expect(JSON.stringify(result[1]).length).toBeLessThan(1000)
  const model = await convertToModelMessages(result)
  const calls = model.filter(message => message.role === 'assistant').flatMap(message => typeof message.content === 'string' ? [] : message.content).filter(part => part.type === 'tool-call')
  const results = model.filter(message => message.role === 'tool').flatMap(message => message.content)
  expect(calls.map(part => part.toolCallId)).toEqual(results.map(part => part.toolCallId))
})

test('failures, mixed batch failures, approvals and pending work retain original details', () => {
  for (const part of [
    { ...readPart, state: 'output-error', errorText: 'failed' },
    { ...readPart, output: { error: 'missing', content: 'diagnostic' } },
    { ...readPart, state: 'approval-requested', approval: { id: 'a' } },
    { ...readPart, approval: { id: 'a', approved: true } },
    { ...readPart, type: 'tool-edit_app_files', output: { ok: false, files: [{ path: 'a', ok: true }, { path: 'b', error: 'conflict' }] } },
    { ...readPart, type: 'tool-edit_app_files', output: { ok: false, files: [{ path: 'a', ok: true }], checks: [{ ok: false, stderr: 'TS error' }] } },
  ]) {
    const messages = history([part])
    expect(compactFileContext(messages)[1]).toEqual(messages[1])
  }
})

test('successful logs are condensed, but failed checks and ordinary dialogue are intact', () => {
  const good = { type: 'tool-run_app_command', state: 'output-available', toolCallId: 'cmd', input: { command: 'bun run typecheck' }, output: { ok: true, stdout: 'log'.repeat(5000), stderr: '' } }
  const bad = { ...good, toolCallId: 'bad', output: { ok: false, stderr: 'TS2345: invalid type', stdout: '' } }
  const messages = history([good, bad])
  const result = compactFileContext(messages)
  expect((result[1].parts[1] as any).output).toEqual({ ok: true, summary: 'Command succeeded; historical logs omitted.' })
  expect(result[1].parts[2]).toEqual(bad)
  expect(result[1].parts[0]).toEqual(messages[1].parts[0])
})
