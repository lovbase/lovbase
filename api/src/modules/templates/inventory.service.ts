import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { randomId } from '../../common/ids'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { qi } from '@lovbase/core/ddl'
import { tables, type InventoryData, type Row } from '@lovbase/core/inventory'
import { InjectPool } from '../../database/pool.provider'
import { DomainError, Forbidden, NotFound } from '../../common/errors'
import { roleFor, schemaFor } from '../roles/roles.service'

const uuid = z.string().uuid()
const optionalId = uuid.nullable().optional()
const numeric = z.coerce.number().finite().nonnegative().max(1e12)
const positive = numeric.refine((n) => n > 0)
const name = z.string().trim().min(1).max(160)
const named = { name, name_en: z.string().max(160).default(''), archived: z.boolean().default(false) }
const product = z.object({
  ...named,
  sku: name,
  description: z.string().max(2000).default(''),
  unit: z.string().max(30).default('each'),
  category_id: optionalId,
  supplier_id: optionalId,
  cost: numeric,
  price: numeric,
  reorder_point: numeric,
  reorder_quantity: numeric,
})
const supplier = z.object({
  ...named,
  contact: z.string().max(160).default(''),
  email: z.string().max(200).default(''),
  phone: z.string().max(80).default(''),
  lead_days: numeric.max(365),
})
const location = z.object({ ...named, parent_id: optionalId })
const line = z.object({ product_id: uuid, location_id: uuid, quantity: positive, cost: numeric })
export const inventoryCommand = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    requestId: uuid,
    table: z.enum(['products', 'suppliers', 'locations']),
    id: uuid.optional(),
    values: z.record(z.string(), z.unknown()),
  }),
  z.object({ action: z.literal('import'), requestId: uuid, products: z.array(product).min(1).max(500) }),
  z.object({
    action: z.literal('movement'),
    requestId: uuid,
    kind: z.enum(['received', 'shipped', 'adjusted', 'transferred']),
    productId: uuid,
    locationId: uuid,
    destinationId: optionalId,
    quantity: numeric,
    note: z.string().max(1000).default(''),
  }),
  z.object({
    action: z.literal('order'),
    requestId: uuid,
    id: uuid.optional(),
    supplierId: uuid,
    expectedAt: z.string().datetime(),
    notes: z.string().max(2000).default(''),
    items: z.array(line).min(1).max(100),
  }),
  z.object({
    action: z.literal('status'),
    requestId: uuid,
    id: uuid,
    status: z.enum(['submitted', 'cancelled']),
  }),
  z.object({
    action: z.literal('receive'),
    requestId: uuid,
    id: uuid,
    items: z
      .array(z.object({ id: uuid, quantity: positive }))
      .min(1)
      .max(100),
  }),
])

@Injectable()
export class InventoryService {
  constructor(@InjectPool() private readonly pool: pg.Pool) {}

  async read(projectId: string): Promise<InventoryData> {
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const meta = await c.query(
        `SELECT p.read_only FROM public.lb_projects p JOIN public.lb_template_instances t ON t.project_id=p.id WHERE p.id=$1 AND t.template_id='inventory'`,
        [projectId],
      )
      if (!meta.rows[0]) throw new NotFound('inventory_not_found')
      await c.query(`SET LOCAL ROLE ${qi(roleFor(projectId))}`)
      await c.query(`SET LOCAL statement_timeout='5s'`)
      const result = { readOnly: !!meta.rows[0].read_only } as InventoryData
      for (const table of tables) {
        const rows = await c.query(
          `SELECT * FROM ${qi(schemaFor(projectId))}.${qi(table)} ORDER BY created_at DESC, id LIMIT 10001`,
        )
        if (rows.rows.length > 10000) throw new DomainError('dataset_too_large')
        result[table] = rows.rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
          ),
        ) as Row[]
      }
      await c.query('COMMIT')
      return result
    } catch (err) {
      await c.query('ROLLBACK')
      throw err
    } finally {
      c.release()
    }
  }

  async command(projectId: string, raw: unknown) {
    const parsed = inventoryCommand.safeParse(raw)
    if (!parsed.success) throw new DomainError('invalid_input')
    const input = parsed.data
    const c = await this.pool.connect()
    const table = (name: string) => `${qi(schemaFor(projectId))}.${qi(name)}`
    try {
      await c.query('BEGIN')
      // Serializes stock commands, including disjoint-looking transfers, in a fixed lock order.
      const project = await c.query(
        `SELECT p.read_only FROM public.lb_projects p JOIN public.lb_template_instances t ON t.project_id=p.id WHERE p.id=$1 AND t.template_id='inventory' FOR UPDATE OF p`,
        [projectId],
      )
      if (!project.rows[0]) throw new NotFound('inventory_not_found')
      if (project.rows[0].read_only) throw new Forbidden('read_only')
      const prior = await c.query(
        'SELECT input,result FROM public.lb_inventory_requests WHERE project_id=$1 AND request_id=$2',
        [projectId, input.requestId],
      )
      if (prior.rows[0]) {
        const same = await c.query(
          'SELECT input=$3::jsonb AS same FROM public.lb_inventory_requests WHERE project_id=$1 AND request_id=$2',
          [projectId, input.requestId, JSON.stringify(input)],
        )
        if (!same.rows[0].same) throw new DomainError('request_conflict')
        await c.query('COMMIT')
        return prior.rows[0].result
      }
      const get = async (t: string, id: string, active = false): Promise<Row> => {
        const r = await c.query(`SELECT * FROM ${table(t)} WHERE id=$1`, [id])
        if (!r.rows[0] || (active && r.rows[0].archived)) throw new DomainError('record_unavailable')
        return r.rows[0]
      }
      const insert = async (t: string, values: Record<string, unknown>) => {
        const id = randomUUID()
        const row = { id, ...values }
        const keys = Object.keys(row)
        await c.query(
          `INSERT INTO ${table(t)} (${keys.map(qi).join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
          Object.values(row),
        )
        return id
      }
      const change = async (productId: string, locationId: string, delta: number | string) => {
        await c.query(
          `INSERT INTO ${table('balances')}(product_id,location_id,quantity) VALUES($1,$2,0) ON CONFLICT(product_id,location_id) DO NOTHING`,
          [productId, locationId],
        )
        const r = await c.query(
          `UPDATE ${table('balances')} SET quantity=quantity+$3 WHERE product_id=$1 AND location_id=$2 AND quantity+$3>=0 RETURNING id`,
          [productId, locationId, delta],
        )
        if (!r.rowCount) throw new DomainError('insufficient_stock')
      }
      const save = async (
        t: 'products' | 'suppliers' | 'locations',
        values: Record<string, unknown>,
        id?: string,
      ) => {
        const p = { products: product, suppliers: supplier, locations: location }[t].safeParse(values)
        if (!p.success) throw new DomainError('invalid_input')
        const row = p.data as Record<string, unknown>
        if (id) await get(t, id)
        if (row.supplier_id) await get('suppliers', String(row.supplier_id), true)
        if (row.category_id) await get('categories', String(row.category_id))
        if (t === 'locations' && row.parent_id) {
          let parent: string | null = String(row.parent_id)
          const seen = new Set<string>(id ? [id] : [])
          while (parent) {
            if (seen.has(parent)) throw new DomainError('location_cycle')
            seen.add(parent)
            const found = await get('locations', parent, true)
            parent = found.parent_id ? String(found.parent_id) : null
          }
        }
        if (t === 'locations' && row.archived && id) {
          const used = await c.query(
            `SELECT 1 FROM ${table('balances')} WHERE location_id=$1 AND quantity>0 UNION ALL SELECT 1 FROM ${table('locations')} WHERE parent_id=$1 AND archived=false`,
            [id],
          )
          if (used.rowCount) throw new DomainError('location_in_use')
        }
        if (!id) return insert(t, row)
        const keys = Object.keys(row)
        await c.query(
          `UPDATE ${table(t)} SET ${keys.map((key, i) => `${qi(key)}=$${i + 2}`).join(',')} WHERE id=$1`,
          [id, ...Object.values(row)],
        )
        return id
      }
      let result: { id?: string; count?: number } = {}
      if (input.action === 'save') result = { id: await save(input.table, input.values, input.id) }
      if (input.action === 'import') {
        for (const row of input.products) await save('products', row)
        result = { count: input.products.length }
      }
      if (input.action === 'movement') {
        await get('products', input.productId, true)
        await get('locations', input.locationId, true)
        if (input.kind !== 'adjusted' && input.quantity <= 0) throw new DomainError('positive_quantity')
        let delta: number | string = input.quantity
        if (input.kind === 'shipped' || input.kind === 'transferred') delta = -input.quantity
        if (input.kind === 'adjusted') {
          const balance = await c.query(
            `SELECT $3::numeric - COALESCE((SELECT quantity FROM ${table('balances')} WHERE product_id=$1 AND location_id=$2),0) AS delta`,
            [input.productId, input.locationId, input.quantity],
          )
          delta = balance.rows[0].delta
        }
        if (input.kind === 'transferred') {
          if (!input.destinationId || input.destinationId === input.locationId)
            throw new DomainError('invalid_destination')
          await get('locations', input.destinationId, true)
          await change(input.productId, input.destinationId, input.quantity)
        }
        await change(input.productId, input.locationId, delta)
        result = {
          id: await insert('movements', {
            product_id: input.productId,
            location_id: input.locationId,
            destination_id: input.kind === 'transferred' ? input.destinationId : null,
            kind: input.kind,
            quantity: input.kind === 'adjusted' ? delta : input.quantity,
            note: input.note,
          }),
        }
      }
      if (input.action === 'order') {
        await get('suppliers', input.supplierId, true)
        if (input.id && (await get('orders', input.id)).status !== 'draft')
          throw new DomainError('invalid_status')
        for (const item of input.items) {
          const prod = await get('products', item.product_id, true)
          if (prod.supplier_id !== input.supplierId) throw new DomainError('supplier_mismatch')
          await get('locations', item.location_id, true)
        }
        const id =
          input.id ||
          (await insert('orders', {
            number: `PO-${Date.now().toString(36).toUpperCase()}-${randomId(4)}`,
            supplier_id: input.supplierId,
            status: 'draft',
            expected_at: input.expectedAt,
            notes: input.notes,
          }))
        if (input.id) {
          await c.query(`UPDATE ${table('orders')} SET supplier_id=$2,expected_at=$3,notes=$4 WHERE id=$1`, [
            id,
            input.supplierId,
            input.expectedAt,
            input.notes,
          ])
          await c.query(`DELETE FROM ${table('order_items')} WHERE order_id=$1`, [id])
        }
        for (const item of input.items) await insert('order_items', { ...item, order_id: id, received: 0 })
        result = { id }
      }
      if (input.action === 'status') {
        const order = await get('orders', input.id)
        const allowed = input.status === 'submitted' ? ['draft'] : ['draft', 'submitted', 'partial']
        if (!allowed.includes(String(order.status))) throw new DomainError('invalid_status')
        await c.query(`UPDATE ${table('orders')} SET status=$2 WHERE id=$1`, [input.id, input.status])
        result = { id: input.id }
      }
      if (input.action === 'receive') {
        const order = await get('orders', input.id)
        if (!['submitted', 'partial'].includes(String(order.status))) throw new DomainError('invalid_status')
        if (new Set(input.items.map((i) => i.id)).size !== input.items.length)
          throw new DomainError('duplicate_item')
        for (const item of input.items) {
          const row = await get('order_items', item.id)
          if (row.order_id !== input.id) throw new DomainError('over_receipt')
          await get('products', String(row.product_id), true)
          await get('locations', String(row.location_id), true)
          // Keep decimal comparisons and arithmetic in Postgres (0.1 + 0.2 must equal 0.3).
          const received = await c.query(
            `UPDATE ${table('order_items')} SET received=received+$2 WHERE id=$1 AND received+$2<=quantity RETURNING id`,
            [item.id, item.quantity],
          )
          if (!received.rowCount) throw new DomainError('over_receipt')
          await change(String(row.product_id), String(row.location_id), item.quantity)
          await insert('movements', {
            product_id: row.product_id,
            location_id: row.location_id,
            order_id: input.id,
            kind: 'received',
            quantity: item.quantity,
            note: order.number,
          })
        }
        const remaining = await c.query(
          `SELECT 1 FROM ${table('order_items')} WHERE order_id=$1 AND received<quantity`,
          [input.id],
        )
        await c.query(`UPDATE ${table('orders')} SET status=$2 WHERE id=$1`, [
          input.id,
          remaining.rowCount ? 'partial' : 'received',
        ])
        result = { id: input.id }
      }
      await c.query(
        'INSERT INTO public.lb_inventory_requests(project_id,request_id,input,result) VALUES($1,$2,$3,$4)',
        [projectId, input.requestId, JSON.stringify(input), JSON.stringify(result)],
      )
      await c.query('COMMIT')
      return result
    } catch (err) {
      await c.query('ROLLBACK')
      if ((err as { code?: string }).code === '23505') throw new DomainError('duplicate_sku')
      throw err
    } finally {
      c.release()
    }
  }
}
