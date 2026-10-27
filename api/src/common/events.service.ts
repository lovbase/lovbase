import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common'
import { Client } from 'pg'
import { ConfigService } from '../config/config.service'

export type LovbaseEvent = {
  topic: string
  type: string
  payload: unknown
}

type Listener = (event: LovbaseEvent) => void

/**
 * Small cross-process event bus for browser state updates.
 *
 * Postgres remains authoritative: publishing only tells connected readers to fetch a snapshot.
 * A dedicated LISTEN connection keeps a busy request pool from being held by every SSE client.
 */
@Injectable()
export class EventsService implements OnApplicationShutdown {
  private readonly log = new Logger('events')
  private readonly listeners = new Map<string, Set<Listener>>()
  private client: Client | null = null
  private connecting: Promise<void> | null = null
  private closed = false

  constructor(private readonly cfg: ConfigService) {}

  private async ready() {
    if (this.closed) throw new Error('events service closed')
    if (this.client) return
    this.connecting ??= (async () => {
      const client = new Client({ connectionString: this.cfg.env.DATABASE_URL })
      client.on('notification', (message) => {
        if (message.channel !== 'lovbase_events' || !message.payload) return
        try {
          const event = JSON.parse(message.payload) as LovbaseEvent
          if (!event?.topic || !event.type) return
          for (const listener of this.listeners.get(event.topic) ?? []) listener(event)
        } catch (error) {
          this.log.warn(`invalid event payload: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
      client.on('error', () => {
        // A later publish/subscribe will establish a fresh connection. Event delivery is best
        // effort and never changes the durable job or notification state.
        this.client = null
      })
      await client.connect()
      await client.query('LISTEN lovbase_events')
      this.client = client
    })().finally(() => { this.connecting = null })
    await this.connecting
  }

  async publish(topic: string, type: string, payload: unknown = {}) {
    const message = JSON.stringify({ topic, type, payload })
    // Keep NOTIFY under PostgreSQL's payload limit. The payload is a hint; clients always reload
    // the latest durable snapshot after receiving it.
    if (Buffer.byteLength(message) > 7_500) return
    try {
      await this.ready()
      await this.client!.query('SELECT pg_notify($1, $2)', ['lovbase_events', message])
    } catch (error) {
      this.log.warn(`event publish failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  subscribe(topics: string[], listener: Listener) {
    for (const topic of topics) {
      let set = this.listeners.get(topic)
      if (!set) this.listeners.set(topic, set = new Set())
      set.add(listener)
    }
    void this.ready().catch(() => {})
    return () => {
      for (const topic of topics) {
        const set = this.listeners.get(topic)
        set?.delete(listener)
        if (set?.size === 0) this.listeners.delete(topic)
      }
    }
  }

  async onApplicationShutdown() {
    this.closed = true
    await this.client?.end().catch(() => {})
    this.client = null
  }
}
