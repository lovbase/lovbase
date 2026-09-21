import { Injectable, Logger } from '@nestjs/common'
import type pg from 'pg'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'

/**
 * A turn, kept as it was sent, so a reload can be handed the same thing again.
 *
 * The alternative — the one this replaces — was to describe the turn alongside it and rebuild
 * something similar on reconnect. That is why a refresh mid-turn kept losing a different facet
 * each time: the steps came back but not the words, then the words but not the clock. Each was a
 * separate thing to remember to write down.
 *
 * Here the bytes of the UI message stream are the record. Replaying them in order reproduces the
 * response exactly, so a resumed turn is not a reconstruction that resembles the original — it is
 * the original, continued.
 *
 * Batched, because the stream is a token at a time and a row per token would be a write storm for
 * the length of a build. A quarter second of latency on a reload nobody is performing is a good
 * trade for two orders of magnitude fewer inserts.
 */
const FLUSH_MS = 250
const FLUSH_BYTES = 8 * 1024
/** How often a follower looks for what has been written since. Faster than a person reads. */
const FOLLOW_MS = 300
/** Chunks outlive their turn by this much, then go. Long enough to reload, short enough to forget. */
const KEEP = '2 hours'

@Injectable()
export class RunStreamService {
  private readonly log = new Logger('run-stream')

  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService) {}

  /**
   * Drain a tee'd copy of the response into storage.
   *
   * Never throws into the caller: this runs beside the turn the user is receiving, and a failure
   * to record it must not disturb the turn itself. The cost of losing it is a reload that cannot
   * resume, which is exactly where we were before.
   */
  async capture(runId: string, stream: ReadableStream<string>) {
    await this.schema.ready()
    const reader = stream.getReader()
    let seq = 0
    let buf = ''
    let last = Date.now()
    const flush = async () => {
      if (!buf) return
      const chunk = buf
      buf = ''
      last = Date.now()
      try {
        await this.pool.query(
          `INSERT INTO public.lb_run_chunks (run_id, seq, chunk) VALUES ($1, $2, $3)
           ON CONFLICT (run_id, seq) DO NOTHING`, [runId, seq++, chunk])
      } catch (err) {
        this.log.error(`chunk write failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += value
        if (buf.length >= FLUSH_BYTES || Date.now() - last >= FLUSH_MS) await flush()
      }
      await flush()
    } catch (err) {
      this.log.error(`capture failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      reader.releaseLock()
      void this.sweep()
    }
  }

  /**
   * Everything recorded for this run from `from` on, in order.
   *
   * `seq` is dense and monotonic per run, so the caller's cursor is just the count it has seen.
   */
  private async since(runId: string, from: number): Promise<{ seq: number; chunk: string }[]> {
    const r = await this.pool.query(
      `SELECT seq, chunk FROM public.lb_run_chunks WHERE run_id = $1 AND seq >= $2 ORDER BY seq`,
      [runId, from])
    return r.rows as { seq: number; chunk: string }[]
  }

  /**
   * The turn so far, then the rest of it as it arrives.
   *
   * Replay and live are one stream to the reader, which is the whole point: a client that
   * reconnects mid-turn cannot tell where the recording stopped and the live part began, and does
   * not have to. Following ends when the run's row closes, because that is the only thing that
   * knows the turn is over — the chunks alone cannot say whether more are coming.
   */
  replay(runId: string, isLive: () => Promise<boolean>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let cursor = 0
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        for (;;) {
          let rows: { seq: number; chunk: string }[]
          try { rows = await this.since(runId, cursor) } catch (err) {
            this.log.error(`replay failed: ${err instanceof Error ? err.message : String(err)}`)
            return void controller.close()
          }
          if (rows.length) {
            for (const r of rows) controller.enqueue(encoder.encode(r.chunk))
            cursor = rows[rows.length - 1].seq + 1
            return
          }
          // Nothing new. The run closing is what ends this, and it is checked only when there is
          // nothing left to send — so a turn that finished still delivers its last chunks first.
          if (!(await isLive())) return void controller.close()
          await new Promise((r) => setTimeout(r, FOLLOW_MS))
        }
      },
    })
  }

  /** Old turns are not worth keeping; nobody reloads into one. */
  private async sweep() {
    try {
      await this.pool.query(`DELETE FROM public.lb_run_chunks WHERE created_at < now() - $1::interval`, [KEEP])
    } catch { /* a bucket that keeps growing is a smaller problem than a failed turn */ }
  }
}
