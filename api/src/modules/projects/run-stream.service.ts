import { Injectable, Logger } from '@nestjs/common'
import { RunChunkStore } from './run-chunk.store'

const FLUSH_MS = 250
const FLUSH_BYTES = 8 * 1024
const TOUCH_MS = 10_000

@Injectable()
export class RunStreamService {
  private readonly log = new Logger('run-stream')
  constructor(private readonly store: RunChunkStore) {}

  /** Recording failure must not interrupt the turn. Always drain the tee, even after failure. */
  async capture(runId: string, stream: ReadableStream<string>) {
    const reader = stream.getReader()
    let recording = true
    let seq = 0
    let buf = ''
    let bytes = 0
    let touched = Date.now()
    const fail = async (err: unknown) => {
      recording = false
      buf = ''; bytes = 0
      this.log.error(`recording ${runId} unavailable: ${err instanceof Error ? err.message : String(err)}`)
      await this.store.discard(runId)
    }
    const flush = async () => {
      if (!buf) return
      await this.store.append(runId, seq++, buf)
      buf = ''; bytes = 0
      touched = Date.now()
    }
    try {
      try { await this.store.begin(runId) } catch (err) { await fail(err) }
      let pending = reader.read()
      let flushed = Date.now()
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const item = await Promise.race([
          pending,
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(1, FLUSH_MS - (Date.now() - flushed))) }),
        ])
        clearTimeout(timer)
        if (item?.done) break
        if (item) {
          if (recording) { buf += item.value; bytes += Buffer.byteLength(item.value) }
        }
        if (Date.now() - flushed >= FLUSH_MS || bytes >= FLUSH_BYTES) {
          if (recording) {
            try {
              await flush()
              if (Date.now() - touched >= TOUCH_MS) { await this.store.touch(runId); touched = Date.now() }
            } catch (err) { await fail(err) }
          }
          flushed = Date.now()
        }
        if (item) pending = reader.read()
      }
      if (recording) { await flush(); await this.store.finish(runId, seq) }
    } catch (err) { await fail(err) } finally { reader.releaseLock() }
  }

  /** Null means use the saved transcript, including for pre-migration runs. */
  async replay(runId: string, isLive: () => Promise<boolean>): Promise<ReadableStream<Uint8Array> | null> {
    if (!await this.store.available(runId)) return null
    let reader: Awaited<ReturnType<RunChunkStore['reader']>>
    try { reader = await this.store.reader(runId) } catch { return null }
    const encoder = new TextEncoder()
    let cursor = '0-0'
    let next = 1
    let cancelled = false
    let stopped = false
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          for (;;) {
            if (cancelled) return
            const rows = await reader.read(cursor, !stopped)
            if (cancelled) return
            for (const row of rows) {
              if (row.id !== `${next++}-0`) throw new Error('recording has a sequence gap')
              cursor = row.id
              if (row.kind === 'end') { reader.close(); controller.close(); return }
              if (row.kind === 'chunk') controller.enqueue(encoder.encode(row.chunk))
              else if (row.kind !== 'start') throw new Error('invalid recording entry')
            }
            if (rows.length) return
            if (stopped) throw new Error('recording interrupted')
            if (!await this.store.available(runId)) throw new Error('recording expired')
            // The end marker can arrive between XREAD timing out and the status query.
            // Once PostgreSQL says closed, drain Redis once more before declaring a crash.
            stopped = !await isLive()
          }
        } catch (err) {
          reader.close()
          if (cancelled) return
          this.log.warn(`replay ${runId} stopped: ${err instanceof Error ? err.message : String(err)}`)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', errorText: 'Stream unavailable. Reloading saved conversation.' })}\n\n`))
          controller.close()
        }
      },
      cancel: () => { cancelled = true; reader.close() },
    })
  }

  close() { this.store.close() }
}
