import pg from 'pg'
import { APP_SCHEMA } from '../shared/ddl'
import { emptyIR, type IR } from '../shared/ir'

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://lovbase:lovbase@localhost:5433/lovbase',
})

export async function initDb() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${APP_SCHEMA}`)
  await pool.query(`CREATE TABLE IF NOT EXISTS public.lovbase_state (
    id int PRIMARY KEY CHECK (id = 1),
    ir jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`)
  await pool.query(`CREATE TABLE IF NOT EXISTS public.lovbase_log (
    id serial PRIMARY KEY,
    role text NOT NULL,
    content jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`)
  await pool.query(
    `INSERT INTO public.lovbase_state (id, ir) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(emptyIR())],
  )
}

export async function getIR(): Promise<IR> {
  const r = await pool.query(`SELECT ir FROM public.lovbase_state WHERE id = 1`)
  return r.rows[0].ir as IR
}

export async function log(role: string, content: unknown) {
  await pool.query(`INSERT INTO public.lovbase_log (role, content) VALUES ($1, $2)`, [
    role, JSON.stringify(content),
  ])
}

export async function getLog() {
  const r = await pool.query(
    `SELECT id, role, content, created_at FROM public.lovbase_log ORDER BY id ASC LIMIT 500`,
  )
  return r.rows
}
