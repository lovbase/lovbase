/**
 * How often to say something on an otherwise silent turn. Well inside the 100 seconds a proxy in
 * front of this typically allows an idle response, and cheap enough to be unnoticeable.
 */
const HEARTBEAT_MS = 15_000

/**
 * Keep a long turn's connection open while it has nothing to say.
 *
 * `edit_app` runs for minutes, and for all of them the stream is silent — the model is blocked on
 * the tool, so not one byte reaches the browser. Every proxy between here and the reader treats a
 * response that quiet as dead and closes it, which the chat surfaces as `network error`: a build
 * that was going perfectly well, abandoned by the page watching it, while the server carried on
 * paying for it.
 *
 * A comment line is the SSE protocol's own answer to this. It carries no event, every conformant
 * parser drops it on the floor, and it is enough to prove the connection is alive.
 */
export function withHeartbeat(out: globalThis.Response, stats?: { lastByteAt: number }): globalThis.Response {
  const body = out.body
  if (!body) return out
  const beat = new TextEncoder().encode(': keep-alive\n\n')
  const reader = body.getReader()
  let open = true
  let timer: ReturnType<typeof setInterval>
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => { if (open) controller.enqueue(beat) }, HEARTBEAT_MS)
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (!open) return
        if (done) {
          open = false
          clearInterval(timer)
          reader.releaseLock()
          controller.close()
          return
        }
        if (stats) stats.lastByteAt = Date.now()
        controller.enqueue(value)
      } catch (err) {
        if (!open) return
        open = false
        clearInterval(timer)
        reader.releaseLock()
        controller.error(err)
      }
    },
    async cancel(reason) {
      open = false
      clearInterval(timer)
      try { await reader.cancel(reason) } finally { reader.releaseLock() }
    },
  })
  return new globalThis.Response(stream, { status: out.status, statusText: out.statusText, headers: out.headers })
}
