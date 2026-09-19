import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'

/** Global key/value settings an admin edits (currently just the platform LLM). */
@Injectable()
export class SettingsService {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService) {}

  async get<T>(key: string): Promise<T | null> {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT value FROM public.lb_settings WHERE key = $1`, [key])
    return (r.rows[0]?.value as T) ?? null
  }

  async set(key: string, value: unknown) {
    await this.pool.query(
      `INSERT INTO public.lb_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, JSON.stringify(value)])
  }

  async delete(key: string) {
    await this.pool.query(`DELETE FROM public.lb_settings WHERE key = $1`, [key])
  }
}
