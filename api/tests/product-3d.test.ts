import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { SchemaService } from '../src/database/schema.service'
import { ConfigService } from '../src/config/config.service'
import { RolesService, roleFor, schemaFor } from '../src/modules/roles/roles.service'
import { TemplatesService } from '../src/modules/templates/templates.service'
import { Product3dService } from '../src/modules/templates/product-3d.service'
import { InventoryService } from '../src/modules/templates/inventory.service'
import { ProjectsService } from '../src/modules/projects/projects.service'
import { WorkspaceGuard } from '../src/modules/data/workspace.guard'
import type { ExecutionContext } from '@nestjs/common'
import type { AccessService } from '../src/modules/auth/access.service'
import { LimitsService } from '../src/modules/limits/limits.service'
import { QuotaExceeded } from '../src/common/errors'

const requestContext = (id: string, bearer?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        params: { workspaceId: id },
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      }),
    }),
  }) as unknown as ExecutionContext

const url = process.env.TEMPLATE_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
suite('3D template lifecycle and transactions on PostgreSQL', () => {
  const pool = new Pool({ connectionString: url })
  const schema = new SchemaService(pool)
  const cfg = ConfigService.of({
    DATABASE_URL: url,
    SQL_ROLE_PASSWORD: 'templates-sql-test',
  })
  const roles = new RolesService(pool, cfg)
  const limits = new LimitsService(pool, cfg, schema)
  const templates = new TemplatesService(pool, schema, roles, limits)
  const service = new Product3dService(pool, limits)
  const projects = new ProjectsService(pool, schema, roles, limits)
  const users: string[] = []
  const ids = new Set<string>()
  async function user() {
    const id = `studio-test-${randomUUID()}`
    users.push(id)
    await pool.query(
      'INSERT INTO public."user"(id,name,email,plan,"createdAt","updatedAt") VALUES($1,$1,$2,\'pro\',now(),now())',
      [id, `${id}@example.invalid`],
    )
    return id
  }
  async function fixture() {
    const userId = await user()
    const created = await templates.create(userId, {
      templateId: 'product-3d',
      version: 1,
      name: 'Studio test',
      locale: 'zh',
      requestId: randomUUID(),
    })
    ids.add(created.projectId)
    const data = await service.read(created.projectId)
    const selection = {
      productId: data.products[0].id,
      optionIds: ['seat', 'frame'].map(
        (part) => data.product_options.find((o) => o.part === part)!.id,
      ),
      quantity: 6,
    }
    return { id: created.projectId, userId, data, selection }
  }
  const command = (id: string, input: Record<string, unknown>) =>
    service.command(id, { requestId: randomUUID(), ...input })
  beforeAll(() => schema.ready(), 30000)
  afterAll(async () => {
    for (const id of ids) await projects.remove(id)
    for (const id of users) await pool.query('DELETE FROM public."user" WHERE id=$1', [id])
    await pool.end()
  })
  test('creates isolated source with dependencies, valid data and retry identity', async () => {
    const userId = await user()
    const input = {
      templateId: 'product-3d' as const,
      version: 1 as const,
      name: 'My studio',
      locale: 'en' as const,
      requestId: randomUUID(),
    }
    const [a, b] = await Promise.all([
      templates.create(userId, input),
      templates.create(userId, input),
    ])
    ids.add(a.projectId)
    expect(a).toEqual(b)
    const data = await service.read(a.projectId)
    expect(data.products).toHaveLength(1)
    expect(data.product_options).toHaveLength(7)
    expect(data.configurations).toHaveLength(2)
    expect(data.inquiries).toHaveLength(2)
    expect(typeof data.products[0].price_cents).toBe('number')
    const files = (
      await pool.query('SELECT files FROM public.lb_app_files WHERE app_id=$1', [a.appId])
    ).rows[0].files as Array<{ path: string; content: string }>
    expect(files.some((f) => f.path === 'src/ChairScene.tsx')).toBe(true)
    expect(
      JSON.parse(files.find((f) => f.path === 'package.json')!.content).dependencies.three,
    ).toBeTruthy()
    expect(JSON.stringify(files)).not.toContain('@lovbase/core/product-3d')
    const sourceUsage = await pool.query(
      "SELECT bytes FROM public.lb_storage_files WHERE key=$1 AND category='source'",
      ['source:' + a.projectId],
    )
    expect(Number(sourceUsage.rows[0].bytes)).toBe(
      files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
    )
    expect(files.find((f) => f.path === 'src/template-config.ts')?.content).toContain("'en'")
    await expect(templates.create(userId, { ...input, templateId: 'inventory' })).rejects.toThrow(
      'request_conflict',
    )
  })
  test('save, reload, update and delete designs; retries do not duplicate rows', async () => {
    const { id, selection } = await fixture()
    const input = {
      action: 'save-configuration',
      name: 'Dining',
      ...selection,
      requestId: randomUUID(),
    }
    const [a, b] = await Promise.all([service.command(id, input), service.command(id, input)])
    expect(a).toEqual(b)
    let data = await service.read(id)
    expect(data.configurations).toHaveLength(3)
    expect(data.configuration_items.filter((i) => i.configuration_id === a.id)).toHaveLength(2)
    await command(id, {
      ...selection,
      action: 'save-configuration',
      id: a.id,
      name: 'Updated',
      quantity: 8,
    })
    data = await service.read(id)
    expect(data.configurations.find((c) => c.id === a.id)?.quantity).toBe(8)
    await expect(service.command(id, { ...input, quantity: 2 })).rejects.toThrow('request_conflict')
    await command(id, { action: 'delete-configuration', id: a.id })
    data = await service.read(id)
    expect(data.configurations).toHaveLength(2)
    expect(data.configuration_items.some((i) => i.configuration_id === a.id)).toBe(false)
  })
  test('account quota rejects writes before mutation and rolls back writes that exceed it', async () => {
    const { id, data, selection } = await fixture()
    const input = {
      action: 'save-configuration',
      name: 'Quota rollback',
      ...selection,
      requestId: randomUUID(),
    }
    const constrainedLimits = new LimitsService(
      pool,
      ConfigService.of({ DATABASE_URL: url, PRO_QUOTA_MB: 0 }),
      schema,
    )
    await expect(new Product3dService(pool, constrainedLimits).command(id, input)).rejects.toThrow(
      'Account storage quota reached',
    )
    // Simulate crossing the boundary during the write, after the real preflight succeeds.
    const assertAccount = limits.assertAccount.bind(limits)
    const quota = spyOn(limits, 'assertAccount')
      .mockImplementationOnce(assertAccount)
      .mockRejectedValueOnce(new QuotaExceeded('Account storage quota reached'))
    try {
      await expect(service.command(id, input)).rejects.toThrow('Account storage quota reached')
      expect(quota).toHaveBeenCalledTimes(2)
    } finally {
      quota.mockRestore()
    }
    expect((await service.read(id)).configurations).toEqual(data.configurations)
    expect((await service.read(id)).configuration_items).toEqual(data.configuration_items)
    expect(
      (await pool.query('SELECT request_id FROM public.lb_product_3d_requests WHERE project_id=$1 AND request_id=$2', [id, input.requestId])).rows,
    ).toHaveLength(0)
    await service.command(id, input)
    expect((await service.read(id)).configurations).toHaveLength(3)
  })
  test('expired Pro uses Free project limits when copying the 3D template', async () => {
    const { id, userId } = await fixture()
    const second = await projects.create(userId)
    ids.add(second.id)
    await pool.query(
      `UPDATE public."user" SET stripe_subscription_id='sub_expired',stripe_paid_until=now()-interval '1 second' WHERE id=$1`,
      [userId],
    )
    await expect(templates.create(userId, {
      templateId: 'product-3d', version: 1, name: 'Over limit', locale: 'zh', requestId: randomUUID(),
    })).rejects.toThrow('Project limit reached')
    expect((await service.read(id)).products).toHaveLength(1)
  })
  test('server pricing ignores tampered totals; inquiry snapshots survive edits and deleted designs', async () => {
    const { id, data, selection } = await fixture()
    const input = {
      action: 'create-inquiry',
      ...selection,
      contact: 'Demo',
      contactInfo: 'demo@example.invalid',
      notes: 'Test',
      total_cents: 1,
      requestId: randomUUID(),
    }
    const created = await service.command(id, input)
    expect(created.quote!.total_cents).toBeGreaterThan(1)
    expect(await service.command(id, input)).toEqual(created)
    const product = data.products[0]
    await command(id, {
      action: 'update-product',
      id: product.id,
      values: { ...product, price_cents: product.price_cents + 10000 },
    })
    const option = data.product_options[0]
    await command(id, {
      action: 'update-option',
      id: option.id,
      values: {
        ...option,
        color: '#ff0000',
        name: 'Changed',
        price_cents: option.price_cents + 10000,
      },
    })
    await command(id, {
      action: 'delete-configuration',
      id: data.configurations[0].id,
    })
    await command(id, {
      action: 'inquiry-status',
      id: created.id,
      status: 'following',
    })
    const inquiry = (await service.read(id)).inquiries.find((i) => i.id === created.id)!
    expect(inquiry.snapshot).toEqual(created.quote!)
    expect(inquiry.status).toBe('following')
  })
  test('disabled choices remain readable but cannot be saved or quoted; failures roll back', async () => {
    const { id, data, selection } = await fixture()
    const option = data.product_options.find((o) => o.id === selection.optionIds[0])!
    await command(id, {
      action: 'update-option',
      id: option.id,
      values: { ...option, enabled: false },
    })
    const before = await service.read(id)
    const requests = (
      await pool.query('SELECT count(*) n FROM public.lb_product_3d_requests WHERE project_id=$1', [
        id,
      ])
    ).rows[0].n
    await expect(
      command(id, {
        action: 'save-configuration',
        name: 'Blocked',
        ...selection,
      }),
    ).rejects.toThrow('option_unavailable')
    await expect(
      command(id, {
        action: 'create-inquiry',
        contact: 'Demo',
        contactInfo: 'test',
        notes: '',
        ...selection,
      }),
    ).rejects.toThrow('option_unavailable')
    expect(await service.read(id)).toEqual(before)
    expect(
      (
        await pool.query(
          'SELECT count(*) n FROM public.lb_product_3d_requests WHERE project_id=$1',
          [id],
        )
      ).rows[0].n,
    ).toBe(requests)
    await expect(
      command(id, {
        action: 'save-configuration',
        name: 'Invalid',
        ...selection,
        quantity: 1.5,
      }),
    ).rejects.toThrow('invalid_input')
  })
  test('cross-project choices and database access are rejected; demo is read-only', async () => {
    const a = await fixture()
    const b = await fixture()
    await expect(
      command(a.id, {
        action: 'save-configuration',
        name: 'Bad',
        ...a.selection,
        optionIds: b.selection.optionIds,
      }),
    ).rejects.toThrow('option_unavailable')
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SET LOCAL ROLE "${roleFor(a.id)}"`)
      await expect(c.query(`SELECT * FROM "${schemaFor(b.id)}".products`)).rejects.toThrow()
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
    const demoId = await templates.ensureDemo('product-3d')
    const demo = await service.read(demoId)
    expect(demo.readOnly).toBe(true)
    expect(
      (await pool.query('SELECT api_token FROM public.lb_projects WHERE id=$1', [demoId])).rows[0]
        .api_token,
    ).toBeNull()
    await expect(
      command(demoId, {
        action: 'delete-configuration',
        id: demo.configurations[0].id,
      }),
    ).rejects.toThrow('read_only')
    const dc = await pool.connect()
    try {
      await dc.query('BEGIN')
      await dc.query(`SET LOCAL ROLE "${roleFor(demoId)}"`)
      await expect(dc.query(`DELETE FROM "${schemaFor(demoId)}".configurations`)).rejects.toThrow()
    } finally {
      await dc.query('ROLLBACK')
      dc.release()
    }
  })
  test('workspace guard rejects anonymous requests and tokens from another workspace', async () => {
    const a = await fixture()
    const b = await fixture()
    const token = (await pool.query('SELECT api_token FROM public.lb_projects WHERE id=$1', [a.id]))
      .rows[0].api_token
    const access = {
      currentUser: async () => null,
    } as unknown as AccessService
    const limits = { allowRequest: () => true } as unknown as LimitsService
    const guard = new WorkspaceGuard(projects, access, limits)
    await expect(guard.canActivate(requestContext(a.id))).rejects.toThrow('missing Authorization')
    await expect(guard.canActivate(requestContext(b.id, token))).rejects.toThrow('invalid token')
    expect(await guard.canActivate(requestContext(a.id, token))).toBe(true)
  })
  test('new template initialization rolls back schema, role, source and project together', async () => {
    const userId = await user()
    const inventory = await templates.ensureDemo()
    expect((await new InventoryService(pool, limits).read(inventory)).products.length).toBeGreaterThan(0)
    const before = (
      await pool.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'p_%' ORDER BY nspname")
    ).rows
    await pool.query(
      `ALTER TABLE public.lb_template_instances ADD CONSTRAINT studio_test_fail CHECK(user_id <> '${userId}')`,
    )
    try {
      await expect(
        templates.create(userId, {
          templateId: 'product-3d',
          version: 1,
          locale: 'zh',
          name: 'Rollback',
          requestId: randomUUID(),
        }),
      ).rejects.toThrow()
    } finally {
      await pool.query('ALTER TABLE public.lb_template_instances DROP CONSTRAINT studio_test_fail')
    }
    expect(
      (
        await pool.query(
          "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'p_%' ORDER BY nspname",
        )
      ).rows,
    ).toEqual(before)
    expect(
      (await pool.query('SELECT id FROM public.lb_projects WHERE owner_id=$1', [userId])).rows,
    ).toHaveLength(0)
  })
})
