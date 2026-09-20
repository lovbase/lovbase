import { describe, expect, test } from 'bun:test'
import { dropEmptyTurns } from '../src/modules/projects/conversation.service'

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

  test('an empty transcript stays empty', () => {
    expect(dropEmptyTurns([])).toEqual([])
  })
})
