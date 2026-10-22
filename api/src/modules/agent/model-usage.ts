import type { Usage } from '@lovbase/core/billing'

export type ObservedUsage = Usage & { cachedTokens: number }
export function providerUsage(body: any): ObservedUsage | null {
  const u = body?.usage
  if (!u) return null
  const input = u.prompt_tokens ?? u.input_tokens,
    output = u.completion_tokens ?? u.output_tokens
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) return null
  const cached =
    u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0
  return {
    inTokens: input,
    outTokens: output,
    cachedTokens: Number.isSafeInteger(cached) && cached >= 0 ? Math.min(input, cached) : 0,
  }
}

/** Observes provider JSON/SSE without modifying bytes sent to the coding agent. */
export function usageObserver(contentType: string, done: (usage: ObservedUsage | null) => Promise<void>) {
  const decoder = new TextDecoder()
  let pending = '',
    observed: ObservedUsage | null = null
  const inspect = (text: string) => {
    try {
      const u = providerUsage(JSON.parse(text))
      if (u) observed = u
    } catch {
      /* SSE comments, DONE, malformed frames */
    }
  }
  const streaming = contentType.includes('text/event-stream')
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      pending += decoder.decode(chunk, { stream: true })
      if (streaming) {
        let end: number
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end).trim()
          pending = pending.slice(end + 1)
          if (line.startsWith('data:')) inspect(line.slice(5).trim())
        }
      }
      if (pending.length > 2_000_000) pending = pending.slice(-1_000_000)
    },
    async flush() {
      pending += decoder.decode()
      if (streaming) {
        if (pending.startsWith('data:')) inspect(pending.slice(5).trim())
      } else inspect(pending)
      await done(observed)
    },
  })
}
