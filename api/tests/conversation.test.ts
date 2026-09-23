import { describe, expect, test } from 'bun:test'
import { dropEmptyTurns, sealOpenTools } from '../src/modules/projects/conversation.service'

// An assistant message with no parts renders as nothing, so the transcript shows two user messages
// back to back and reads as one message sent twice. This is the filter that keeps them out.

const user = (text: string, id = text) => ({ id, role: 'user', parts: [{ type: 'text', text }] })
const empty = (id: string) => ({ id, role: 'assistant', parts: [] })

describe('dropEmptyTurns', () => {
  test('drops an assistant turn that produced nothing', () => {
    const kept = dropEmptyTurns([user('a'), empty('e1'), user('b')])
    expect(kept.map((m: any) => m.id)).toEqual(['a', 'b'])
  })

  test('keeps a turn whose only output was a tool call, which is a real turn', () => {
    const toolOnly = { id: 't', role: 'assistant', parts: [{ type: 'tool-edit_app', state: 'output-available' }] }
    expect(dropEmptyTurns([toolOnly])).toEqual([toolOnly])
  })

  test('keeps a message with no parts field at all rather than guessing it is empty', () => {
    const odd = { id: 'x', role: 'assistant' }
    expect(dropEmptyTurns([odd])).toEqual([odd])
  })

  test('repairs a transcript that already had them, since a save rewrites the whole array', () => {
    const before = [user('一'), empty('e1'), user('一', 'dup'), empty('e2'), user('二')]
    expect(dropEmptyTurns(before).map((m: any) => m.id)).toEqual(['一', 'dup', '二'])
  })

  test('drops a turn that holds only a step marker and an empty sentence', () => {
    const blank = { id: 'b', role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: '', state: 'streaming' }] }
    expect(dropEmptyTurns([user('a'), blank]).map((m: any) => m.id)).toEqual(['a'])
    const said = { id: 's', role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: '我来', state: 'streaming' }] }
    expect(dropEmptyTurns([user('a'), said]).length).toBe(2)
  })

  test('an empty transcript stays empty', () => {
    expect(dropEmptyTurns([])).toEqual([])
  })
})

// A turn cut short leaves its last tool call open: a spinner with nothing behind it, and a message
// a model cannot be asked to continue from. Sealing closes it with a reason — and nothing else.
describe('sealOpenTools', () => {
  const open = { type: 'tool-write_app_file', toolCallId: 'c1', state: 'input-available' }
  const done = { type: 'tool-read_app_file', toolCallId: 'c0', state: 'output-available', output: {} }

  test('marks the open tool call of the last assistant message as errored, with the reason', () => {
    const { messages, sealed } = sealOpenTools([user('q'), { id: 'a', role: 'assistant', parts: [done, open] }], '中断')
    expect(sealed).toBe(1)
    const parts = (messages[1] as any).parts
    expect(parts[0]).toEqual(done)
    expect(parts[1]).toMatchObject({ state: 'output-error', errorText: '中断' })
  })

  test('leaves a transcript whose last message is the user alone', () => {
    const before = [{ id: 'a', role: 'assistant', parts: [open] }, user('q')]
    expect(sealOpenTools(before, 'x')).toEqual({ messages: before, sealed: 0 })
  })

  test('closes a sentence that was still streaming, keeping its words', () => {
    const { messages, sealed } = sealOpenTools([user('q'), { id: 'a', role: 'assistant', parts: [{ type: 'text', text: '我来', state: 'streaming' }] }], 'x')
    expect(sealed).toBe(1)
    expect((messages[1] as any).parts[0]).toEqual({ type: 'text', text: '我来', state: 'done' })
  })

  test('changes nothing when every call has finished', () => {
    const before = [user('q'), { id: 'a', role: 'assistant', parts: [done] }]
    expect(sealOpenTools(before, 'x').sealed).toBe(0)
    expect(sealOpenTools(before, 'x').messages).toBe(before)
  })
})
