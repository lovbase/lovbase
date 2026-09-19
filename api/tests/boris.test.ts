import { describe, expect, test } from 'bun:test'
import { summarize } from '../src/modules/agent/boris'

/** One JSONL line as pi emits it. */
const ev = (o: unknown) => JSON.stringify(o)
const stream = (...lines: string[]) => lines.join('\n')

const editedTwoFiles = stream(
  ev({ type: 'tool_execution_start', toolCallId: '1', toolName: 'edit', args: { path: '/workspace/app/src/App.tsx' } }),
  ev({ type: 'tool_execution_end', toolCallId: '1' }),
  ev({ type: 'tool_execution_start', toolCallId: '2', toolName: 'write', args: { path: '/workspace/app/src/index.css' } }),
  ev({ type: 'tool_execution_end', toolCallId: '2' }),
  ev({ type: 'agent_end' }),
)

describe('summarize — what the transcript shows after a build', () => {
  test('plain output passes through untouched', () => {
    expect(summarize('done in 3s')).toBe('done in 3s')
  })

  test('the closing narration is used when it reads like prose', () => {
    const s = summarize(stream(
      ev({ type: 'text_delta', delta: 'thinking about the layout\n\n' }),
      ev({ type: 'text_delta', delta: '暗黑模式已加入计算器。' }),
      ev({ type: 'agent_end' }),
    ))
    expect(s).toBe('暗黑模式已加入计算器。')
  })

  // The bug this exists for: pi sends tool arguments down the same channel as its narration, so
  // the accumulated text was half a React component and the transcript rendered it as the summary.
  test('source code is never shown as the summary', () => {
    const code = 'const [state, dispatch] = useReducer(reducer, initialState)\\n return (\\n <main className="flex min-h-dvh">\\n'
    const s = summarize(stream(
      ev({ type: 'tool_execution_start', toolCallId: '1', toolName: 'write', args: { path: '/workspace/app/src/App.tsx' } }),
      ev({ type: 'tool_execution_end', toolCallId: '1' }),
      ev({ type: 'text_delta', delta: code }),
      ev({ type: 'agent_end' }),
    ))
    expect(s).not.toContain('className')
    expect(s).not.toContain('useReducer')
    expect(s).toContain('src/App.tsx')
  })

  test('falls back to the files it touched', () => {
    const s = summarize(editedTwoFiles)
    expect(s).toContain('2 个文件')
    expect(s).toContain('src/App.tsx')
    expect(s).toContain('src/index.css')
  })

  test('says something even when nothing was captured', () => {
    expect(summarize(ev({ type: 'agent_end' }))).toBe('完成')
  })

  test('a long narration is capped rather than flooding the transcript', () => {
    const long = 'x'.repeat(5000)
    expect(summarize(stream(ev({ type: 'text_delta', delta: long }), ev({ type: 'agent_end' }))).length).toBeLessThanOrEqual(600)
  })
})
