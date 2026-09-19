// End-to-end golden path against the real Postgres:
// create table -> insert data -> rename via diff -> data survives.
import { diffIR } from '../src/shared/diff'
import type { IR } from '../src/shared/ir'
import { getIR, initDb, pool } from '../src/server/db'
import { applyChanges } from '../src/server/apply'
import { insertRow, listRows } from '../src/server/data'

await initDb()
// reset from any previous smoke run
await pool.query('DROP SCHEMA IF EXISTS app_main CASCADE')
await pool.query('CREATE SCHEMA app_main')
await pool.query(`UPDATE public.lovbase_state SET ir = '{"version":1,"appName":"Untitled","entities":[]}' WHERE id = 1`)

const v1: IR = {
  version: 1, appName: '客户管理',
  entities: [{
    id: 'e_1', name: '客户', dbName: 'customers',
    fields: [
      { id: 'f_1', name: '姓名', dbName: 'name', type: 'text', required: true },
      { id: 'f_2', name: '状态', dbName: 'status', type: 'select', required: false, options: ['潜在', '成交'] },
    ],
  }],
}
await applyChanges(v1, diffIR(await getIR(), v1))
await insertRow('e_1', { f_1: '张三', f_2: '潜在' })
await insertRow('e_1', { f_1: '李四', f_2: '成交' })

// second change: rename table + rename column + add column — nothing destructive
const v2: IR = JSON.parse(JSON.stringify(v1))
v2.entities[0].name = '客户档案'
v2.entities[0].dbName = 'customer_profiles'
v2.entities[0].fields[0].dbName = 'full_name'
v2.entities[0].fields.push({ id: 'f_3', name: '电话', dbName: 'phone', type: 'text', required: false })
const changes = diffIR(await getIR(), v2)
console.log('changes:', changes.map((c) => c.kind).join(', '))
await applyChanges(v2, changes)

const rows = await listRows('e_1')
console.log('rows after rename:', rows.length, JSON.stringify(rows.map((r) => r.full_name)))
if (rows.length !== 2 || !rows.some((r) => r.full_name === '张三')) throw new Error('DATA LOST!')
const cols = await pool.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='app_main' AND table_name='customer_profiles' ORDER BY ordinal_position`)
console.log('physical columns:', cols.rows.map((r) => r.column_name).join(', '))
console.log('✅ golden path holds: renamed twice, added a column, zero data loss')
await pool.end()
