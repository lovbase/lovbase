import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { qi } from '@lovbase/core/ddl'
import {
  MAX_PRICE_CENTS,
  MAX_QUANTITY,
  product3dTables,
  quoteProduct,
  type Product,
  type ProductOption,
  type Product3dData,
  type Product3dResult,
} from '@lovbase/core/product-3d'
import { InjectPool } from '../../database/pool.provider'
import { DomainError, Forbidden, NotFound } from '../../common/errors'
import { roleFor, schemaFor } from '../roles/roles.service'
import { LimitsService } from '../limits/limits.service'

const uuid = z.string().uuid()
const displayName = z.string().trim().min(1).max(160)
const price = z.number().int().min(0).max(MAX_PRICE_CENTS)
const selection = {
  productId: uuid,
  optionIds: z.array(uuid).length(2),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
}
export const product3dCommand = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save-configuration'),
    requestId: uuid,
    id: uuid.optional(),
    name: displayName,
    ...selection,
  }),
  z.object({
    action: z.literal('delete-configuration'),
    requestId: uuid,
    id: uuid,
  }),
  z.object({
    action: z.literal('create-inquiry'),
    requestId: uuid,
    contact: displayName,
    contactInfo: z.string().trim().min(1).max(200),
    notes: z.string().max(2000),
    ...selection,
  }),
  z.object({
    action: z.literal('inquiry-status'),
    requestId: uuid,
    id: uuid,
    status: z.enum(['new', 'following', 'completed', 'cancelled']),
  }),
  z.object({
    action: z.literal('update-product'),
    requestId: uuid,
    id: uuid,
    values: z.object({
      name: displayName,
      name_en: displayName,
      description: z.string().max(2000),
      description_en: z.string().max(2000),
      price_cents: price,
    }),
  }),
  z.object({
    action: z.literal('update-option'),
    requestId: uuid,
    id: uuid,
    values: z.object({
      name: displayName,
      name_en: displayName,
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      roughness: z.number().min(0).max(1),
      price_cents: price,
      enabled: z.boolean(),
    }),
  }),
])
const numericFields = new Set(['price_cents', 'roughness', 'quantity'])
function decode(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key === 'snapshot'
        ? JSON.parse(String(value))
        : numericFields.has(key)
          ? Number(value)
          : value instanceof Date
            ? value.toISOString()
            : value,
    ]),
  )
}

@Injectable()
export class Product3dService {
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly limits: LimitsService,
  ) {}

  async read(projectId: string): Promise<Product3dData> {
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const meta = await c.query(
        `SELECT p.read_only FROM public.lb_projects p JOIN public.lb_template_instances t ON t.project_id=p.id WHERE p.id=$1 AND t.template_id='product-3d' AND t.version=1`,
        [projectId],
      )
      if (!meta.rows[0]) throw new NotFound('product_3d_not_found')
      await c.query(`SET LOCAL ROLE ${qi(roleFor(projectId))}`)
      await c.query(`SET LOCAL statement_timeout='5s'`)
      const data = { readOnly: !!meta.rows[0].read_only } as Product3dData
      for (const table of product3dTables) {
        const result = await c.query(
          `SELECT * FROM ${qi(schemaFor(projectId))}.${qi(table)} ORDER BY created_at DESC,id LIMIT 10001`,
        )
        if (result.rows.length > 10000) throw new DomainError('dataset_too_large')
        // Each table is installed by the versioned model; only transport normalization happens here.
        Object.assign(data, { [table]: result.rows.map(decode) })
      }
      await c.query('COMMIT')
      return data
    } catch (error) {
      await c.query('ROLLBACK')
      throw error
    } finally {
      c.release()
    }
  }

  async command(projectId: string, raw: unknown): Promise<Product3dResult> {
    const parsed = product3dCommand.safeParse(raw)
    if (!parsed.success) throw new DomainError('invalid_input')
    const input = parsed.data
    const c = await this.pool.connect()
    const table = (name: string) => `${qi(schemaFor(projectId))}.${qi(name)}`
    try {
      await c.query('BEGIN')
      const owner = await this.limits.beforeWrite(c, projectId)
      const meta = await c.query(
        `SELECT p.read_only FROM public.lb_projects p JOIN public.lb_template_instances t ON t.project_id=p.id WHERE p.id=$1 AND t.template_id='product-3d' AND t.version=1 FOR UPDATE OF p`,
        [projectId],
      )
      if (!meta.rows[0]) throw new NotFound('product_3d_not_found')
      if (meta.rows[0].read_only) throw new Forbidden('read_only')
      const previous = await c.query(
        `SELECT result,input=$3::jsonb AS same FROM public.lb_product_3d_requests WHERE project_id=$1 AND request_id=$2`,
        [projectId, input.requestId, JSON.stringify(input)],
      )
      if (previous.rows[0]) {
        if (!previous.rows[0].same) throw new DomainError('request_conflict')
        await c.query('COMMIT')
        return previous.rows[0].result
      }
      // Run business mutations with the same restricted database role as the workspace data API.
      await c.query(`SET LOCAL ROLE ${qi(roleFor(projectId))}`)
      await c.query(`SET LOCAL statement_timeout='5s'`)
      const get = async (t: string, id: string) => {
        const result = await c.query(`SELECT * FROM ${table(t)} WHERE id=$1 FOR UPDATE`, [id])
        if (!result.rows[0]) throw new DomainError('record_unavailable')
        return decode(result.rows[0])
      }
      const insert = async (t: string, values: Record<string, unknown>) => {
        const row = { id: randomUUID(), ...values }
        const keys = Object.keys(row)
        await c.query(
          `INSERT INTO ${table(t)} (${keys.map(qi).join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
          Object.values(row),
        )
        return row.id
      }
      const update = async (t: string, id: string, values: Record<string, unknown>) => {
        const keys = Object.keys(values)
        await c.query(
          `UPDATE ${table(t)} SET ${keys.map((key, i) => `${qi(key)}=$${i + 2}`).join(',')} WHERE id=$1`,
          [id, ...Object.values(values)],
        )
      }
      let result: Product3dResult
      if (input.action === 'save-configuration' || input.action === 'create-inquiry') {
        const product = (await get('products', input.productId)) as Product
        const optionRows = await c.query(
          `SELECT * FROM ${table('product_options')} WHERE product_id=$1 ORDER BY id FOR UPDATE`,
          [input.productId],
        )
        const options = optionRows.rows.map(decode) as ProductOption[]
        let quote
        try {
          quote = quoteProduct(product, options, input)
        } catch (error) {
          throw new DomainError(error instanceof Error ? error.message : 'invalid_input')
        }
        if (input.action === 'save-configuration') {
          const values = {
            product_id: product.id,
            name: input.name,
            quantity: input.quantity,
            snapshot: JSON.stringify(quote),
          }
          let id = input.id
          if (id) {
            const existing = await get('configurations', id)
            if (existing.product_id !== product.id) throw new DomainError('invalid_options')
            await update('configurations', id, values)
            await c.query(`DELETE FROM ${table('configuration_items')} WHERE configuration_id=$1`, [
              id,
            ])
          } else id = await insert('configurations', values)
          for (const option of quote.options)
            await insert('configuration_items', {
              configuration_id: id,
              option_id: option.id,
            })
          result = { id, quote }
        } else {
          const id = await insert('inquiries', {
            product_id: product.id,
            contact: input.contact,
            contact_info: input.contactInfo,
            notes: input.notes,
            status: 'new',
            snapshot: JSON.stringify(quote),
          })
          result = { id, quote }
        }
      } else if (input.action === 'delete-configuration') {
        await get('configurations', input.id)
        await c.query(`DELETE FROM ${table('configuration_items')} WHERE configuration_id=$1`, [
          input.id,
        ])
        await c.query(`DELETE FROM ${table('configurations')} WHERE id=$1`, [input.id])
        result = { id: input.id }
      } else if (input.action === 'inquiry-status') {
        await get('inquiries', input.id)
        await update('inquiries', input.id, { status: input.status })
        result = { id: input.id }
      } else {
        const target = input.action === 'update-product' ? 'products' : 'product_options'
        await get(target, input.id)
        await update(target, input.id, input.values)
        result = { id: input.id }
      }
      await c.query('RESET ROLE')
      await this.limits.assertAccount(owner, c)
      await c.query(
        `INSERT INTO public.lb_product_3d_requests(project_id,request_id,input,result) VALUES($1,$2,$3,$4)`,
        [projectId, input.requestId, JSON.stringify(input), JSON.stringify(result)],
      )
      await c.query('COMMIT')
      return result
    } catch (error) {
      await c.query('ROLLBACK')
      throw error
    } finally {
      c.release()
    }
  }
}
