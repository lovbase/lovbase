import type { IR } from '@lovbase/core/ir'

/**
 * A workspace. It owns the data model (the IR), one Postgres schema (`p_<id>`), a low-privilege
 * role (`ws_<id>`), and any number of apps built on top of it.
 */
export type Project = {
  id: string
  owner_id: string
  name: string
  ir: IR
  share_token: string | null
  api_token: string
  folder_id: string | null
  starred: boolean
  read_only: boolean
  created_at: string
  updated_at: string
}

export type LogEntry = { id: number; role: string; content: any; created_at: string }
