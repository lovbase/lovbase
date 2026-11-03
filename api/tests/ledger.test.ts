import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { SchemaService } from '../src/database/schema.service'
import { ConfigService } from '../src/config/config.service'
import { RolesService, roleFor, schemaFor } from '../src/modules/roles/roles.service'
import { TemplatesService } from '../src/modules/templates/templates.service'
import { LedgerService } from '../src/modules/templates/ledger.service'
import { ProjectsService } from '../src/modules/projects/projects.service'
import { LimitsService } from '../src/modules/limits/limits.service'
import { isBalanced } from '@lovbase/core/ledger'

const url = process.env.TEMPLATE_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
suite('Ledger template books on PostgreSQL', () => {
  const pool = new Pool({ connectionString: url })
  const schema = new SchemaService(pool)
  const cfg = ConfigService.of({ DATABASE_URL: url, SQL_ROLE_PASSWORD: 'templates-sql-test' })
  const roles = new RolesService(pool, cfg)
  const limits = new LimitsService(pool, cfg, schema)
  const templates = new TemplatesService(pool, schema, roles, limits)
  const service = new LedgerService(pool, limits)
  const projects = new ProjectsService(pool, schema, roles, limits)
  const users: string[] = []
  const ids = new Set<string>()
  async function fixture() {
    const userId = `ledger-test-${randomUUID()}`
    users.push(userId)
    await pool.query(
      'INSERT INTO public."user"(id,name,email,plan,"createdAt","updatedAt") VALUES($1,$1,$2,\'pro\',now(),now())',
      [userId, `${userId}@example.invalid`],
    )
    const created = await templates.create(userId, {
      templateId: 'ledger',
      version: 1,
      name: 'Ledger test',
      locale: 'zh',
      requestId: randomUUID(),
    })
    ids.add(created.projectId)
    const data = await service.read(created.projectId)
    const find = (name: string) => data.accounts.find((a) => a.name_en === name)!
    return { id: created.projectId, data, find }
  }
  const command = (id: string, input: Record<string, unknown>) =>
    service.command(id, { requestId: randomUUID(), ...input })
  // Runs as the project's own database role, the way the SQL console and data API reach it.
  async function asProject<T>(id: string, run: (c: import('pg').PoolClient, table: (n: string) => string) => Promise<T>) {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SET LOCAL ROLE "${roleFor(id)}"`)
      const result = await run(c, (n) => `"${schemaFor(id)}"."${n}"`)
      await c.query('COMMIT')
      return result
    } catch (error) {
      await c.query('ROLLBACK')
      throw error
    } finally {
      c.release()
    }
  }
  beforeAll(() => schema.ready(), 30000)
  afterAll(async () => {
    for (const id of ids) await projects.remove(id)
    for (const id of users) await pool.query('DELETE FROM public."user" WHERE id=$1', [id])
    await pool.end()
  })

  test('seeded books balance entry by entry and include every kind of activity', async () => {
    const { data } = await fixture()
    expect(data.readOnly).toBe(false)
    expect(data.accounts.length).toBeGreaterThan(15)
    expect(data.entries.length).toBeGreaterThan(60)
    expect(typeof data.postings[0].amount_cents).toBe('number')
    for (const entry of data.entries)
      expect(isBalanced(data.postings.filter((p) => p.entry_id === entry.id))).toBe(true)
    expect(new Set(data.entries.map((e) => e.kind))).toEqual(new Set(['opening', 'expense', 'income', 'transfer']))
    expect(data.budgets.length).toBeGreaterThan(0)
  })

  test('records, retries and reverses without double booking', async () => {
    const { id, find } = await fixture()
    const input = {
      action: 'record',
      requestId: randomUUID(),
      kind: 'expense',
      occurredOn: '2026-10-20',
      payee: 'Bakery',
      memo: '',
      fromAccountId: find('EUR account').id,
      toAccountId: find('Dining out').id,
      amountCents: 10_000,
    }
    const [a, b] = await Promise.all([service.command(id, input), service.command(id, input)])
    expect(a).toEqual(b)
    let data = await service.read(id)
    const legs = data.postings.filter((p) => p.entry_id === a.id).sort((x, y) => x.amount_cents - y.amount_cents)
    expect(legs.map((p) => [p.amount_cents, p.base_cents])).toEqual([[-10_000, -10_870], [10_870, 10_870]])
    await expect(service.command(id, { ...input, amountCents: 1 })).rejects.toThrow('request_conflict')
    const reversal = await command(id, { action: 'reverse', entryId: a.id, occurredOn: '2026-10-21' })
    await expect(command(id, { action: 'reverse', entryId: a.id, occurredOn: '2026-10-21' })).rejects.toThrow('already_reversed')
    await expect(command(id, { action: 'reverse', entryId: reversal.id, occurredOn: '2026-10-21' })).rejects.toThrow('cannot_reverse_reversal')
    data = await service.read(id)
    const net = data.postings.filter((p) => p.entry_id === a.id || p.entry_id === reversal.id).reduce((s, p) => s + p.amount_cents, 0)
    expect(net).toBe(0)
    expect(data.entries.find((e) => e.id === reversal.id)?.reverses).toBe(a.id)
  })

  test('server re-plans from stored rates and rejects nonsense', async () => {
    const { id, find } = await fixture()
    await command(id, { action: 'set-rate', currency: 'EUR', rate: 0.5 })
    const { id: entry } = await command(id, {
      action: 'record', kind: 'expense', occurredOn: '2026-10-20', payee: '', memo: '',
      fromAccountId: find('EUR account').id, toAccountId: find('Groceries').id, amountCents: 1_000,
      base_cents: 1,
    })
    const data = await service.read(id)
    expect(data.postings.find((p) => p.entry_id === entry && p.amount_cents > 0)?.base_cents).toBe(500)
    const base = { action: 'record', kind: 'expense', occurredOn: '2026-10-20', payee: '', memo: '', amountCents: 100 }
    await expect(command(id, { ...base, fromAccountId: find('Salary').id, toAccountId: find('Groceries').id })).rejects.toThrow('invalid_accounts')
    await expect(command(id, { ...base, fromAccountId: find('Savings').id, toAccountId: find('Savings').id })).rejects.toThrow('same_account')
    await expect(command(id, { ...base, amountCents: -5, fromAccountId: find('Savings').id, toAccountId: find('Groceries').id })).rejects.toThrow('invalid_input')
    expect((await service.read(id)).entries).toHaveLength(data.entries.length)
  })

  test('accounts: opening balance, locked type and currency, USD-only categories', async () => {
    const { id, find } = await fixture()
    const { id: wallet } = await command(id, {
      action: 'save-account', name: '英镑现金', name_en: 'GBP cash', kind: 'asset', currency: 'GBP',
      archived: false, openingCents: 20_000, openedOn: '2026-10-01',
    })
    const data = await service.read(id)
    const legs = data.postings.filter((p) => p.account_id === wallet)
    expect(legs.map((p) => [p.amount_cents, p.base_cents])).toEqual([[20_000, 25_480]])
    await expect(
      command(id, { action: 'save-account', id: wallet, name: 'x', name_en: '', kind: 'asset', currency: 'EUR', archived: false }),
    ).rejects.toThrow('account_locked')
    await expect(
      command(id, { action: 'save-account', name: 'Fees', name_en: '', kind: 'expense', currency: 'GBP', archived: false }),
    ).rejects.toThrow('category_base_currency')
    await command(id, { action: 'save-account', id: find('Shopping').id, name: '购物', name_en: 'Shopping', kind: 'expense', currency: 'USD', archived: true })
    await expect(
      command(id, { action: 'record', kind: 'expense', occurredOn: '2026-10-20', payee: '', memo: '', fromAccountId: find('Savings').id, toAccountId: find('Shopping').id, amountCents: 100 }),
    ).rejects.toThrow('account_unavailable')
  })

  test('budgets upsert per month and zero removes them', async () => {
    const { id, find } = await fixture()
    const accountId = find('Health').id
    await command(id, { action: 'set-budget', accountId, month: '2027-01', amountCents: 50_000 })
    await command(id, { action: 'set-budget', accountId, month: '2027-01', amountCents: 60_000 })
    let rows = (await service.read(id)).budgets.filter((b) => b.account_id === accountId && b.month === '2027-01')
    expect(rows.map((b) => b.amount_cents)).toEqual([60_000])
    await command(id, { action: 'set-budget', accountId, month: '2027-01', amountCents: 0 })
    rows = (await service.read(id)).budgets.filter((b) => b.account_id === accountId && b.month === '2027-01')
    expect(rows).toHaveLength(0)
    await expect(command(id, { action: 'set-budget', accountId: find('Salary').id, month: '2027-01', amountCents: 1 })).rejects.toThrow('record_unavailable')
    await expect(command(id, { action: 'set-budget', accountId, month: '2027-13', amountCents: 1 })).rejects.toThrow('invalid_input')
  })

  test('the database itself keeps the books balanced and append-only', async () => {
    const { id, data, find } = await fixture()
    const entry = data.entries[0]
    await expect(asProject(id, (c, t) => c.query(`DELETE FROM ${t('postings')} WHERE entry_id=$1`, [entry.id]))).rejects.toThrow('ledger_append_only')
    await expect(asProject(id, (c, t) => c.query(`UPDATE ${t('entries')} SET memo='x' WHERE id=$1`, [entry.id]))).rejects.toThrow('ledger_append_only')
    // One-sided entry: rejected at commit by the deferred trigger.
    await expect(
      asProject(id, async (c, t) => {
        const e = await c.query(`INSERT INTO ${t('entries')}(occurred_on,kind) VALUES('2026-10-01','expense') RETURNING id`)
        await c.query(`INSERT INTO ${t('postings')}(entry_id,account_id,amount_cents,base_cents) VALUES($1,$2,100,100)`, [e.rows[0].id, find('Groceries').id])
      }),
    ).rejects.toThrow('ledger_unbalanced')
    await expect(
      asProject(id, (c, t) => c.query(`INSERT INTO ${t('entries')}(occurred_on,kind) VALUES('2026-10-01','expense')`)),
    ).rejects.toThrow('ledger_unbalanced')
    // A balanced pair written by hand is accepted: the rules, not the service, are the boundary.
    await asProject(id, async (c, t) => {
      const e = await c.query(`INSERT INTO ${t('entries')}(occurred_on,kind) VALUES('2026-10-01','expense') RETURNING id`)
      for (const [account, cents] of [[find('Savings').id, -100], [find('Groceries').id, 100]] as const)
        await c.query(`INSERT INTO ${t('postings')}(entry_id,account_id,amount_cents,base_cents) VALUES($1,$2,$3,$3)`, [e.rows[0].id, account, cents])
    })
    await expect(
      asProject(id, (c, t) => c.query(`INSERT INTO ${t('accounts')}(name,kind,currency) VALUES('Fees','expense','GBP')`)),
    ).rejects.toThrow()
    expect((await service.read(id)).entries).toHaveLength(data.entries.length + 1)
  })

  test('the gallery demo is read-only', async () => {
    const demoId = await templates.ensureDemo('ledger')
    const demo = await service.read(demoId)
    expect(demo.readOnly).toBe(true)
    await expect(command(demoId, { action: 'set-rate', currency: 'EUR', rate: 1 })).rejects.toThrow('read_only')
    await expect(
      asProject(demoId, (c, t) => c.query(`INSERT INTO ${t('fx_rates')}(currency,rate) VALUES('GBP',1)`)),
    ).rejects.toThrow()
  })
})
