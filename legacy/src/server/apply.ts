import type { Change } from '../shared/diff'
import { changeToSQL } from '../shared/ddl'
import type { IR } from '../shared/ir'
import { log, pool } from './db'

export async function applyChanges(next: IR, changes: Change[]) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const change of changes)
      for (const sql of changeToSQL(change, next)) await client.query(sql)
    await client.query(`UPDATE public.lovbase_state SET ir = $1, updated_at = now() WHERE id = 1`, [
      JSON.stringify(next),
    ])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    await log('error', { message: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    client.release()
  }
  await log('agent', { note: '已应用', changes })
}
