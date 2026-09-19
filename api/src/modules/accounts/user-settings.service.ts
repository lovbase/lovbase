import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'

/** Per-user BYOK configuration. The key is stored encrypted; this layer never decrypts. */
export type UserSettings = { llm_base_url: string | null; llm_api_key_enc: string | null; llm_model: string | null }

@Injectable()
export class UserSettingsService {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService) {}

  async get(userId: string): Promise<UserSettings | null> {
    await this.schema.ready()
    const r = await this.pool.query(
      `SELECT llm_base_url, llm_api_key_enc, llm_model FROM public.lb_user_settings WHERE user_id = $1`, [userId])
    return (r.rows[0] as UserSettings) ?? null
  }

  async save(userId: string, s: UserSettings) {
    await this.schema.ready()
    await this.pool.query(
      `INSERT INTO public.lb_user_settings (user_id, llm_base_url, llm_api_key_enc, llm_model)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET llm_base_url = $2, llm_api_key_enc = $3, llm_model = $4, updated_at = now()`,
      [userId, s.llm_base_url, s.llm_api_key_enc, s.llm_model])
  }

  async clear(userId: string) {
    await this.pool.query(`DELETE FROM public.lb_user_settings WHERE user_id = $1`, [userId])
  }
}
