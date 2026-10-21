import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { SchemaService } from '../src/database/schema.service'
import { ConfigService } from '../src/config/config.service'
import { RolesService, roleFor, schemaFor } from '../src/modules/roles/roles.service'
import { TemplatesService, DEMO_PROJECT } from '../src/modules/templates/templates.service'
import { InventoryService } from '../src/modules/templates/inventory.service'
import { ProjectsService } from '../src/modules/projects/projects.service'
import { quantity } from '@lovbase/core/inventory'

// Explicit opt-in: this suite creates disposable users, schemas and roles in a TEST database.
const url = process.env.TEMPLATE_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
suite('template creation and inventory transactions on PostgreSQL', () => {
  const pool = new pg.Pool({ connectionString: url })
  const schema = new SchemaService(pool)
  const cfg = ConfigService.of({ DATABASE_URL: url, SQL_ROLE_PASSWORD: 'templates-sql-test' })
  const roles = new RolesService(pool, cfg)
  const service = new TemplatesService(pool, schema, roles)
  const inventory = new InventoryService(pool)
  const projects = new ProjectsService(pool, schema, roles)
  const userIds: string[] = []
  const projectIds = new Set<string>()
  let serial = 0
  async function user(plan = 'pro') {
    const id = 'templates-test-' + randomUUID()
    userIds.push(id)
    await pool.query(
      'INSERT INTO public."user"(id,name,email,plan,"createdAt","updatedAt") VALUES($1,$1,$2,$3,now(),now())',
      [id, `${id}@example.invalid`, plan],
    )
    return id
  }
  async function remix(userId: string, requestId = randomUUID()) {
    const r = await service.create(userId, {
      templateId: 'inventory',
      version: 1,
      name: `Test ${++serial}`,
      locale: 'zh',
      requestId,
    })
    projectIds.add(r.projectId)
    return r.projectId
  }
  const command = (id: string, input: Record<string, unknown>) =>
    inventory.command(id, { requestId: randomUUID(), ...input })
  beforeAll(async () => {
    await schema.ready()
  }, 30000)
  afterAll(async () => {
    for (const id of projectIds) await projects.remove(id)
    for (const id of userIds) await pool.query('DELETE FROM public."user" WHERE id=$1', [id])
    await pool.end()
  })
  test('concurrent retries create one independent, named bilingual source copy', async () => {
    const userId = await user(),
      requestId = randomUUID()
    const input = {
      templateId: 'inventory' as const,
      version: 1 as const,
      name: '我的库存',
      locale: 'zh' as const,
      requestId,
    }
    const [a, b] = await Promise.all([service.create(userId, input), service.create(userId, input)])
    projectIds.add(a.projectId)
    expect(a).toEqual(b)
    const state = await inventory.read(a.projectId)
    expect(state.products).toHaveLength(30)
    expect(state.readOnly).toBe(false)
    const project = await projects.get(a.projectId)
    expect(project.name).toBe('我的库存')
    const files = (await pool.query('SELECT files FROM public.lb_app_files WHERE app_id=$1', [a.appId]))
      .rows[0].files
    expect(files.find((f: any) => f.path === 'src/template-config.ts').content).toContain("'zh'")
    expect(files.find((f: any) => f.path === 'src/InventoryApp.tsx').content).toContain('InventoryApp')
    expect(files.find((f: any) => f.path === 'src/labels.ts').content).toContain('Purchase orders')
    expect(JSON.stringify(files)).not.toContain('@lovbase/core/inventory')
    expect(JSON.stringify(files)).not.toContain(project.api_token)
  })
  test('concurrent blank and template creation share the plan quota lock', async () => {
    const userId = await user('free')
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        i % 2
          ? service.create(userId, {
              templateId: 'inventory',
              version: 1,
              name: 'Limit',
              locale: 'en',
              requestId: randomUUID(),
            })
          : projects.create(userId).then((p) => ({ projectId: p.id, appId: p.id })),
      ),
    )
    const successes = attempts.filter((r) => r.status === 'fulfilled')
    for (const r of successes) if (r.status === 'fulfilled') projectIds.add(r.value.projectId)
    expect(successes.length).toBe(2)
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(4)
  })
  test('failed initialization rolls back project, tables, role, source and receipt', async () => {
    const userId = await user()
    const catalog = async () =>
      (
        await pool.query(`
      SELECT 'schema' AS kind, nspname AS name FROM pg_namespace WHERE nspname LIKE 'p_%'
      UNION ALL SELECT 'role', rolname FROM pg_roles WHERE rolname LIKE 'ws_%'
      UNION ALL SELECT 'source', app_id FROM public.lb_app_files
      UNION ALL SELECT 'receipt', project_id FROM public.lb_template_instances
      ORDER BY kind, name
    `)
      ).rows
    const before = await catalog()
    await pool.query(
      `ALTER TABLE public.lb_template_instances ADD CONSTRAINT template_test_failure CHECK(user_id <> '${userId}')`,
    )
    try {
      await expect(remix(userId)).rejects.toThrow()
    } finally {
      await pool.query('ALTER TABLE public.lb_template_instances DROP CONSTRAINT template_test_failure')
    }
    expect(
      (await pool.query('SELECT count(*)::int n FROM public.lb_projects WHERE owner_id=$1', [userId])).rows[0]
        .n,
    ).toBe(0)
    expect(await catalog()).toEqual(before)
    const retry = await remix(userId)
    expect((await inventory.read(retry)).products).toHaveLength(30)
  })
  test('users have isolated balances and isolated database roles', async () => {
    const a = await remix(await user()),
      b = await remix(await user())
    const state = await inventory.read(a),
      before = await inventory.read(b)
    const balance = state.balances[0]
    await command(a, {
      action: 'movement',
      kind: 'received',
      productId: balance.product_id,
      locationId: balance.location_id,
      quantity: 9,
    })
    expect((await inventory.read(b)).balances).toEqual(before.balances)
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SET LOCAL ROLE "${roleFor(a)}"`)
      await expect(c.query(`SELECT * FROM "${schemaFor(b)}".products`)).rejects.toThrow()
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })
  test('demo data has no API token and cannot write at the service or database boundary', async () => {
    const id = await service.ensureDemo()
    expect(id).toBe(DEMO_PROJECT)
    expect((await inventory.read(id)).readOnly).toBe(true)
    expect((await projects.get(id)).api_token).toBeNull()
    await expect(
      command(id, {
        action: 'import',
        products: [{ name: 'No', sku: 'NO', cost: 1, price: 1, reorder_point: 0, reorder_quantity: 0 }],
      }),
    ).rejects.toThrow('read_only')
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SET LOCAL ROLE "${roleFor(id)}"`)
      await expect(c.query(`DELETE FROM "${schemaFor(id)}".products`)).rejects.toThrow()
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })
  test('seeded stock is consistent with the movement ledger', async () => {
    const id = await remix(await user()),
      state = await inventory.read(id)
    for (const product of state.products) {
      const sum = state.movements
        .filter((m) => m.product_id === product.id)
        .reduce((s, m) => s + (m.kind === 'shipped' ? -1 : 1) * Number(m.quantity), 0)
      expect(quantity(state, product.id)).toBe(sum)
    }
  })
  test('concurrent shipment cannot oversell; replay cannot apply a movement twice', async () => {
    const id = await remix(await user()),
      state = await inventory.read(id)
    const balance = state.balances.find((b) => Number(b.quantity) > 0)!
    const input = {
      action: 'movement',
      kind: 'shipped',
      productId: balance.product_id,
      locationId: balance.location_id,
      quantity: Number(balance.quantity),
    }
    const results = await Promise.allSettled([command(id, input), command(id, input)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(quantity(await inventory.read(id), String(balance.product_id), String(balance.location_id))).toBe(
      0,
    )
    const requestId = randomUUID()
    await command(id, { ...input, kind: 'received', quantity: 7, requestId })
    await command(id, { ...input, kind: 'received', quantity: 7, requestId })
    expect(quantity(await inventory.read(id), String(balance.product_id), String(balance.location_id))).toBe(
      7,
    )
    await expect(command(id, { ...input, kind: 'received', quantity: 8, requestId })).rejects.toThrow(
      'request_conflict',
    )
  })
  test('failed transfers roll back the destination and do not append movements', async () => {
    const id = await remix(await user()),
      state = await inventory.read(id)
    const balance = state.balances[0],
      destination = state.locations.find((l) => l.id !== balance.location_id)!
    await expect(
      command(id, {
        action: 'movement',
        kind: 'transferred',
        productId: balance.product_id,
        locationId: balance.location_id,
        destinationId: destination.id,
        quantity: Number(balance.quantity) + 1,
      }),
    ).rejects.toThrow('insufficient_stock')
    const after = await inventory.read(id)
    expect(after.balances).toEqual(state.balances)
    expect(after.movements).toEqual(state.movements)
    await command(id, {
      action: 'movement',
      kind: 'received',
      productId: balance.product_id,
      locationId: balance.location_id,
      quantity: 2,
    })
    await command(id, {
      action: 'movement',
      kind: 'transferred',
      productId: balance.product_id,
      locationId: balance.location_id,
      destinationId: destination.id,
      quantity: 2,
    })
    expect(quantity(await inventory.read(id), String(balance.product_id))).toBe(
      quantity(state, String(balance.product_id)) + 2,
    )
  })
  test('draft editing, partial receipt, replay, overreceipt and completion form one consistent flow', async () => {
    const id = await remix(await user()),
      state = await inventory.read(id)
    const product = state.products[0],
      location = state.locations[0]
    const created = await command(id, {
      action: 'order',
      supplierId: product.supplier_id,
      expectedAt: new Date().toISOString(),
      items: [{ product_id: product.id, location_id: location.id, quantity: 10, cost: 5 }],
    })
    await command(id, {
      action: 'order',
      id: created.id,
      supplierId: product.supplier_id,
      expectedAt: new Date().toISOString(),
      items: [{ product_id: product.id, location_id: location.id, quantity: 12, cost: 6 }],
    })
    await command(id, { action: 'status', id: created.id, status: 'submitted' })
    const item = (await inventory.read(id)).order_items.find((i) => i.order_id === created.id)!
    const receipt = {
      action: 'receive',
      id: created.id,
      items: [{ id: item.id, quantity: 5 }],
      requestId: randomUUID(),
    }
    await command(id, receipt)
    await command(id, receipt)
    let after = await inventory.read(id)
    expect(after.orders.find((o) => o.id === created.id)?.status).toBe('partial')
    expect(quantity(after, product.id)).toBe(quantity(state, product.id) + 5)
    await expect(
      command(id, { action: 'receive', id: created.id, items: [{ id: item.id, quantity: 8 }] }),
    ).rejects.toThrow('over_receipt')
    await command(id, { action: 'receive', id: created.id, items: [{ id: item.id, quantity: 7 }] })
    after = await inventory.read(id)
    expect(after.orders.find((o) => o.id === created.id)?.status).toBe('received')
    expect(quantity(after, product.id)).toBe(quantity(state, product.id) + 12)
    await expect(command(id, { action: 'status', id: created.id, status: 'cancelled' })).rejects.toThrow(
      'invalid_status',
    )
  })
  test('fractional receipts and adjustments retain exact decimal stock', async () => {
    const id = await remix(await user())
    const state = await inventory.read(id)
    const product = state.products[0],
      location = state.locations[0]
    const movement = { action: 'movement', kind: 'adjusted', productId: product.id, locationId: location.id }
    await command(id, { ...movement, quantity: 0.1 })
    await command(id, { ...movement, quantity: 0.3 })
    let balance = (await inventory.read(id)).balances.find(
      (b) => b.product_id === product.id && b.location_id === location.id,
    )!
    expect(String(balance.quantity)).toBe('0.3')
    const order = await command(id, {
      action: 'order',
      supplierId: product.supplier_id,
      expectedAt: new Date().toISOString(),
      items: [{ product_id: product.id, location_id: location.id, quantity: 0.3, cost: 1 }],
    })
    await command(id, { action: 'status', id: order.id, status: 'submitted' })
    const item = (await inventory.read(id)).order_items.find((i) => i.order_id === order.id)!
    for (const amount of [0.1, 0.2])
      await command(id, { action: 'receive', id: order.id, items: [{ id: item.id, quantity: amount }] })
    const after = await inventory.read(id)
    expect(after.orders.find((o) => o.id === order.id)?.status).toBe('received')
    balance = after.balances.find((b) => b.id === balance.id)!
    expect(String(balance.quantity)).toBe('0.6')
  })
  test('invalid bulk import is atomic; archive and location cycles are validated', async () => {
    const id = await remix(await user()),
      state = await inventory.read(id)
    const row = { name: 'New', sku: 'NEW', cost: 1, price: 2, reorder_point: 2, reorder_quantity: 10 }
    await expect(
      command(id, { action: 'import', products: [row, { ...row, sku: state.products[0].sku }] }),
    ).rejects.toThrow('duplicate_sku')
    expect((await inventory.read(id)).products).toHaveLength(30)
    const child = state.locations.find((l) => l.parent_id)!
    const parent = state.locations.find((l) => l.id === child.parent_id)!
    await expect(
      command(id, {
        action: 'save',
        table: 'locations',
        id: parent.id,
        values: { ...parent, parent_id: child.id },
      }),
    ).rejects.toThrow('location_cycle')
    await expect(
      command(id, {
        action: 'save',
        table: 'locations',
        id: parent.id,
        values: { ...parent, archived: true },
      }),
    ).rejects.toThrow('location_in_use')
  })
})
