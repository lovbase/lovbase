import { describe, expect, test } from 'bun:test'
import express from 'express'
import { withHeartbeat } from '../src/common/sse'
import { sendFetchResponse } from '../src/common/http'
import { UI_MESSAGE_STREAM_HEADERS } from 'ai'
import { TurnService } from '../src/modules/agent/turn.service'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('run resume lifecycle', () => {
  test('HTTP disconnect cancels through heartbeat into the replay reader', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"start","messageId":"a"}\n\n')) },
      cancel() { cancelled = true },
    })
    const app = express()
    app.get('/stream', (_req, res) => sendFetchResponse(res, withHeartbeat(new Response(body, { headers: UI_MESSAGE_STREAM_HEADERS }))))
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const port = (server.address() as { port: number }).port
    const abort = new AbortController()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/stream`, { signal: abort.signal })
      expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
      const reader = response.body!.getReader()
      await reader.read()
      abort.abort()
      for (let i = 0; i < 20; i++) {
        if (cancelled) break
        await delay(10)
      }
      expect(cancelled).toBe(true)
    } finally {
      abort.abort()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('run stays open until recording has flushed its tail', async () => {
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const stream = {
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
      toUIMessageStream(options: any) {
        return new ReadableStream({
          async start(c) {
            c.enqueue({ type: 'start', messageId: 'a' })
            c.enqueue({ type: 'finish', finishReason: 'stop' })
            await options.onFinish({ messages: [{ id: 'a', role: 'assistant', parts: [] }] })
            c.close()
          },
        })
      },
    }
    const service = new TurnService(
      { prepare: async () => {}, stream: async () => stream } as any,
      { saveChat: async () => { events.push('saved') }, sealChat: async () => {}, endRun: async () => { events.push('closed') }, touchRun: async () => {} } as any,
      { capture: async (_id: string, body: ReadableStream<string>) => {
        for await (const _ of body) { /* drain the real tee */ }
        events.push('tail pending')
        await gate
        events.push('tail flushed')
      } } as any,
      { charge: async () => {} } as any,
    )
    // This test targets lifecycle ordering, not the SDK's incremental message parser.
    Object.assign(service, { persist: async (body: ReadableStream) => {
      for await (const _ of body) { /* consume the transcript branch */ }
    } })
    const live = await service.start({
      runId: 'r', project: { id: 'p' }, app: { id: 'a' }, userId: 'u', cfg: { model: 'test' },
      stored: [], forModel: [], pricer: { charge: () => ({ credits: 0, costUsd: 0 }) }, byok: true,
    } as any)
    try {
      for (let i = 0; i < 50 && !events.includes('tail pending'); i++) await delay(10)
      expect(events).toContain('tail pending')
      expect(events).not.toContain('closed')
    } finally { release(); await live.done }
    expect(events.indexOf('tail flushed')).toBeLessThan(events.indexOf('closed'))
    expect(live.ended).toBe(true)
  })
})
