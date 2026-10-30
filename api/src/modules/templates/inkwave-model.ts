import type pg from 'pg'
import type { IR } from '@lovbase/core/ir'
import { qi } from '@lovbase/core/ddl'

// The game stores player preferences in the browser and has no business tables.
export const inkwaveIR: IR = { version: 1, appName: 'INKWAVE', entities: [] }

export async function installInkwave(client: pg.PoolClient, schema: string) {
  await client.query(`CREATE SCHEMA ${qi(schema)}`)
}

export async function seedInkwave(_client: pg.PoolClient, _schema: string) {}
