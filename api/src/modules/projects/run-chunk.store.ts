import { Injectable, Logger } from '@nestjs/common'
import Redis from 'ioredis'
import { ConfigService } from '../../config/config.service'

type Entry = [string, string[]]
export type RunChunk = { id: string; kind: string; chunk: string }

// Explicit IDs make retries idempotent. Reject missing history and bound memory without
// trimming the prefix that the UI protocol needs to reconstruct the message.
const APPEND = `
local key, id, kind, chunk = KEYS[1], ARGV[1], ARGV[2], ARGV[3]
local existing = redis.call('XRANGE', key, id, id)
if #existing > 0 then
  local fields = existing[1][2]
  if fields[2] ~= kind or fields[4] ~= chunk then return redis.error_reply('conflicting chunk') end
  redis.call('EXPIRE', key, ARGV[4])
  return id
end
local last = redis.call('XREVRANGE', key, '+', '-', 'COUNT', 1)
local total = string.len(chunk)
if kind == 'start' then
  if #last > 0 then return redis.error_reply('run already exists') end
else
  if #last == 0 then return redis.error_reply('run expired') end
  if last[1][1] ~= ARGV[6] then return redis.error_reply('chunk sequence gap') end
  if last[1][2][2] == 'end' then return redis.error_reply('run already ended') end
  total = total + tonumber(last[1][2][6])
end
if total > tonumber(ARGV[5]) then return redis.error_reply('run recording exceeds byte limit') end
redis.call('XADD', key, id, 'kind', kind, 'chunk', chunk, 'bytes', total)
redis.call('EXPIRE', key, ARGV[4])
return id
`

@Injectable()
export class RunChunkStore {
  private readonly log = new Logger('run-chunks')
  private readonly client: Redis
  private connecting: Promise<void> | null = null
  private closed = false
  private readonly readers = new Set<Redis>()

  constructor(private readonly cfg: ConfigService) { this.client = this.connection() }

  private connection(): Redis {
    const client = new Redis(this.cfg.env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      commandTimeout: 3000,
      retryStrategy: () => null,
    })
    // Operations report failures; never log credentials from a connection URL.
    client.on('error', () => {})
    return client
  }

  private async ready() {
    if (this.closed) throw new Error('run recording store closed')
    if (this.client.status === 'ready') return
    this.connecting ??= this.client.connect().finally(() => { this.connecting = null })
    await this.connecting
  }

  private key(runId: string) { return `lb:run:{${runId}}:chunks` }

  private async write(runId: string, index: number, kind: string, chunk = '') {
    await this.ready()
    const args = [this.key(runId), `${index}-0`, kind, chunk,
      this.cfg.env.RUN_CHUNKS_TTL_SECONDS, this.cfg.env.RUN_CHUNKS_MAX_BYTES, `${index - 1}-0`]
    // A timed-out write may have succeeded. The same ID cannot duplicate its bytes.
    try { await this.client.eval(APPEND, 1, ...args) } catch (err) {
      if (!(err instanceof Error) || !/timeout/i.test(err.message)) throw err
      await this.client.eval(APPEND, 1, ...args)
    }
  }

  begin(runId: string) { return this.write(runId, 1, 'start') }
  append(runId: string, seq: number, chunk: string) { return this.write(runId, seq + 2, 'chunk', chunk) }
  finish(runId: string, count: number) { return this.write(runId, count + 2, 'end') }

  async touch(runId: string) {
    await this.ready()
    if (!await this.client.expire(this.key(runId), this.cfg.env.RUN_CHUNKS_TTL_SECONDS))
      throw new Error('run recording expired')
  }

  async discard(runId: string) {
    try { await this.ready(); await this.client.del(this.key(runId)) } catch {
      this.log.warn(`could not discard recording for ${runId}; TTL will remove it`)
    }
  }

  async available(runId: string): Promise<boolean> {
    try {
      await this.ready()
      const first = await this.client.xrange(this.key(runId), '-', '+', 'COUNT', 1)
      return first[0]?.[0] === '1-0' && first[0]?.[1]?.[1] === 'start'
    } catch { return false }
  }

  /** Each reader has its own connection and cursor: BLOCK must not block writers or peers. */
  async reader(runId: string) {
    if (this.closed) throw new Error('run recording store closed')
    const client = this.connection()
    this.readers.add(client)
    const close = () => { this.readers.delete(client); client.disconnect() }
    try { await client.connect() } catch (err) { close(); throw err }
    return {
      read: async (cursor: string, block = true): Promise<RunChunk[]> => {
        const result = block
          ? await client.xread('COUNT', 64, 'BLOCK', 1000, 'STREAMS', this.key(runId), cursor)
          : await client.xread('COUNT', 64, 'STREAMS', this.key(runId), cursor)
        return ((result?.[0]?.[1] ?? []) as Entry[]).map(([id, fields]) => {
          const data = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]]))
          return { id, kind: data.kind, chunk: data.chunk }
        })
      },
      close,
    }
  }

  /** Called after TurnService has drained in-flight recordings. */
  close() {
    this.closed = true
    for (const reader of this.readers) reader.disconnect()
    this.readers.clear()
    this.client.disconnect()
  }
}
