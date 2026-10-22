import { test, expect } from 'bun:test'
import { providerUsage, usageObserver } from '../src/modules/agent/model-usage'

test('provider usage preserves measured cached tokens and rejects invented counts', () => {
  expect(
    providerUsage({
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } },
    }),
  ).toEqual({ inTokens: 100, outTokens: 20, cachedTokens: 60 })
  expect(providerUsage({ usage: { input_tokens: 3, output_tokens: 4 } })).toMatchObject({ inTokens: 3, outTokens: 4 })
  expect(providerUsage({ choices: [] })).toBeNull()
  expect(providerUsage({ usage: { prompt_tokens: -1, completion_tokens: 2 } })).toBeNull()
})
test('fragmented SSE passes through byte-for-byte and meters the final usage once', async () => {
  const source =
    ': ping\n\ndata: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\ndata: [DONE]\n\n'
  const bytes = new TextEncoder().encode(source),
    results: unknown[] = []
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3))
      c.close()
    },
  }).pipeThrough(
    usageObserver('text/event-stream', async (u) => {
      results.push(u)
    }),
  )
  expect(await new Response(stream).text()).toBe(source)
  expect(results).toEqual([{ inTokens: 11, outTokens: 7, cachedTokens: 0 }])
})
test('non-streaming and missing usage never fabricate a model charge', async () => {
  for (const [text, wanted] of [
    ['{"usage":{"input_tokens":2,"output_tokens":0}}', { inTokens: 2, outTokens: 0, cachedTokens: 0 }],
    ['{"choices":[]}', null],
  ] as const) {
    let result: unknown = 'not finished'
    await new Response(
      new Response(text).body!.pipeThrough(
        usageObserver('application/json', async (u) => {
          result = u
        }),
      ),
    ).text()
    expect(result).toEqual(wanted)
  }
})
