import { pool } from './db'
import { getIR } from './db'
import { APP_SCHEMA } from '../shared/ddl'
import { DB_NAME_RE } from '../shared/ir'

// Column names NEVER come from the request — the client sends field ids,
// we resolve them against the IR. DB_NAME_RE is the second lock on the door.
const qi = (s: string) => {
  if (!DB_NAME_RE.test(s)) throw new Error(`illegal identifier: ${s}`)
  return `"${s}"`
}

export async function listRows(entityId: string) {
  const ir = await getIR()
  const e = ir.entities.find((x) => x.id === entityId)
  if (!e) throw new Error('unknown entity')
  const r = await pool.query(
    `SELECT * FROM "${APP_SCHEMA}".${qi(e.dbName)} ORDER BY created_at DESC LIMIT 200`,
  )
  return r.rows
}

export async function insertRow(entityId: string, values: Record<string, unknown>) {
  const ir = await getIR()
  const e = ir.entities.find((x) => x.id === entityId)
  if (!e) throw new Error('unknown entity')
  const cols: string[] = []
  const params: unknown[] = []
  for (const [fieldId, value] of Object.entries(values)) {
    const f = e.fields.find((x) => x.id === fieldId)
    if (!f || value === '' || value == null) continue
    cols.push(qi(f.dbName))
    params.push(f.type === 'number' ? Number(value) : value)
  }
  if (cols.length === 0) throw new Error('empty row')
  const placeholders = params.map((_, i) => `$${i + 1}`).join(', ')
  const r = await pool.query(
    `INSERT INTO "${APP_SCHEMA}".${qi(e.dbName)} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    params,
  )
  return r.rows[0]
}

export async function deleteRow(entityId: string, rowId: string) {
  const ir = await getIR()
  const e = ir.entities.find((x) => x.id === entityId)
  if (!e) throw new Error('unknown entity')
  await pool.query(`DELETE FROM "${APP_SCHEMA}".${qi(e.dbName)} WHERE id = $1`, [rowId])
}
