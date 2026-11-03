import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Pool, type PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { SchemaService } from '../src/database/schema.service'
import { ConfigService } from '../src/config/config.service'
import { RolesService, roleFor, schemaFor } from '../src/modules/roles/roles.service'
import { TemplatesService } from '../src/modules/templates/templates.service'
import { ProjectsService } from '../src/modules/projects/projects.service'
import { LimitsService } from '../src/modules/limits/limits.service'
import { SqlService } from '../src/modules/sql/sql.service'
import {
  bookingTables,
  errorKey,
  findConflict,
  readStatements,
  statementFor,
  type BookingAction,
  type BookingData,
} from '@lovbase/core/booking'

const url = process.env.TEMPLATE_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
suite('Bookings template on PostgreSQL', () => {
  const pool = new Pool({ connectionString: url })
  const schema = new SchemaService(pool)
  const cfg = ConfigService.of({ DATABASE_URL: url, SQL_ROLE_PASSWORD: 'templates-sql-test' })
  const roles = new RolesService(pool, cfg)
  const limits = new LimitsService(pool, cfg, schema)
  const templates = new TemplatesService(pool, schema, roles, limits)
  const projects = new ProjectsService(pool, schema, roles, limits)
  // The data API's own executor: logs in as lovbase_sql and switches to the workspace role.
  const sqlPool = new Pool({ connectionString: cfg.sqlUrl })
  const sql = new SqlService(sqlPool, pool, limits)
  const users: string[] = []
  const ids = new Set<string>()
  // Far enough ahead that the seed has nothing there; times are Shanghai business hours.
  const day = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)
  const at = (time: string) => `${day}T${time}:00+08:00`

  async function fixture() {
    const userId = `booking-test-${randomUUID()}`
    users.push(userId)
    await pool.query(
      'INSERT INTO public."user"(id,name,email,plan,"createdAt","updatedAt") VALUES($1,$1,$2,\'pro\',now(),now())',
      [userId, `${userId}@example.invalid`],
    )
    const created = await templates.create(userId, {
      templateId: 'booking',
      version: 1,
      name: 'Bookings test',
      locale: 'en',
      requestId: randomUUID(),
    })
    ids.add(created.projectId)
    const data = (await templates.readTables(created.projectId, 'booking')) as unknown as BookingData
    const resource = (name: string) => data.resources.find((r) => r.name_en === name)!.id
    const service = (name: string) => data.services.find((s) => s.name_en === name)!
    return { id: created.projectId, data, resource, service, customer: data.customers[0].id }
  }
  // Runs as the project's own database role, the way the SQL console and data API reach it.
  async function asProject<T>(id: string, run: (c: PoolClient, table: (n: string) => string) => Promise<T>) {
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
  const insertBooking = (id: string, values: { resource: string; service: string; customer: string; from: string; to?: string; status?: string }) =>
    asProject(id, (c, t) =>
      c.query(
        `INSERT INTO ${t('bookings')}(resource_id,service_id,customer_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4,$5,coalesce($6,'confirmed')) RETURNING id, ends_at, price_cents`,
        [values.resource, values.service, values.customer, at(values.from), values.to ? at(values.to) : null, values.status ?? null],
      ),
    )
  // What the copied app does: the statement from domain.ts, through the SQL API, as JSON.
  async function run(id: string, action: BookingAction) {
    const statement = statementFor(action)
    return sql.run(await roles.ensureWorkspaceRole(id), schemaFor(id), statement.sql, statement.params)
  }
  async function read(id: string) {
    const role = await roles.ensureWorkspaceRole(id)
    const data: Record<string, unknown> = {}
    for (const table of bookingTables)
      data[table] = JSON.parse(JSON.stringify((await sql.run(role, schemaFor(id), readStatements[table])).rows))
    return data as unknown as Omit<BookingData, 'readOnly'>
  }

  beforeAll(async () => {
    await schema.ready()
    await roles.ensureExecutorRole()
  }, 30000)
  afterAll(async () => {
    for (const id of ids) await projects.remove(id)
    for (const id of users) await pool.query('DELETE FROM public."user" WHERE id=$1', [id])
    await sqlPool.end()
    await pool.end()
  })

  test('the seed is a believable studio: six weeks of bookings, none overlapping', async () => {
    const { data } = await fixture()
    expect(data.readOnly).toBe(false)
    expect(data.resources).toHaveLength(4)
    expect(data.services.length).toBeGreaterThanOrEqual(6)
    expect(data.customers.length).toBeGreaterThanOrEqual(40)
    expect(data.opening_hours.map((h) => h.weekday).sort()).toEqual([1, 2, 3, 4, 5, 6])
    expect(data.bookings.length).toBeGreaterThan(300)
    expect(data.bookings.length).toBeLessThan(1000)
    expect(new Set(data.bookings.map((b) => b.status))).toEqual(new Set(['confirmed', 'completed', 'cancelled', 'no_show']))
    const now = Date.now()
    expect(data.bookings.some((b) => Date.parse(b.starts_at) > now + 7 * 86_400_000)).toBe(true)
    expect(data.bookings.some((b) => Date.parse(b.starts_at) < now - 21 * 86_400_000)).toBe(true)
    const services = new Map(data.services.map((s) => [s.id, s]))
    for (const b of data.bookings) {
      // The trigger filled in the end and the price from the service.
      const s = services.get(b.service_id)!
      expect(Date.parse(b.ends_at) - Date.parse(b.starts_at)).toBe(s.duration_min * 60_000)
      expect(b.price_cents).toBe(s.price_cents)
      expect(findConflict(data.bookings, b)).toBeUndefined()
      // Inside the studio's Shanghai opening hours.
      const local = new Date(Date.parse(b.starts_at) + 8 * 3_600_000)
      const hours = data.opening_hours.find((h) => h.weekday === local.getUTCDay())!
      expect(local.toISOString().slice(11, 16) >= hours.opens).toBe(true)
      expect(new Date(Date.parse(b.ends_at) + 8 * 3_600_000).toISOString().slice(11, 16) <= hours.closes).toBe(true)
    }
    // Past bookings are settled; nothing in the future is.
    expect(data.bookings.filter((b) => Date.parse(b.ends_at) > now && b.status !== 'confirmed' && b.status !== 'cancelled')).toHaveLength(0)
  })

  test('readTables hands the preview numbers and ISO strings, the same rows the client reads', async () => {
    const { id, data } = await fixture()
    expect(typeof data.services[0].duration_min).toBe('number')
    expect(typeof data.services[0].price_cents).toBe('number')
    expect(typeof data.bookings[0].price_cents).toBe('number')
    expect(typeof data.opening_hours[0].weekday).toBe('number')
    expect(data.bookings[0].starts_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    const client = await read(id)
    for (const table of bookingTables) {
      const byId = (rows: { id: string }[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
      expect(byId(client[table])).toEqual(byId(data[table] as { id: string }[]) as never)
    }
  })

  test("the client's statements work through the SQL API, and the database maps a clash to booking_overlap", async () => {
    const { id, resource, service } = await fixture()
    const lin = resource('Dr. Lin')
    const assessment = service('Initial assessment')
    const customer = randomUUID()
    await run(id, { type: 'save-customer', id: customer, name: ' Ada Lovelace ', phone: '+44 20 0000 0000', email: 'ada@example.com', notes: '' })
    const first = randomUUID()
    const book = { type: 'book' as const, id: first, resourceId: lin, serviceId: assessment.id, customerId: customer, startsAt: at('10:00'), notes: 'First visit' }
    expect((await run(id, book)).rowCount).toBe(1)
    // A retry after a lost response is a no-op, not a clash and not a second row.
    expect((await run(id, book)).rowCount).toBe(0)
    const clash = { ...book, id: randomUUID(), startsAt: at('10:30') }
    const error = await run(id, clash).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect(errorKey((error as Error).message)).toBe('booking_overlap')
    await run(id, { type: 'set-status', id: first, status: 'cancelled' })
    await run(id, clash)
    // Moving the cancelled one back onto its old slot is now refused.
    await expect(run(id, { type: 'set-status', id: first, status: 'confirmed' })).rejects.toThrow('booking_overlap')
    await run(id, { type: 'edit-booking', id: first, resourceId: resource('Marco Ruiz'), serviceId: service('Myofascial release').id, startsAt: at('10:00'), notes: '' })
    await run(id, { type: 'set-status', id: first, status: 'confirmed' })
    await run(id, { type: 'set-status', id: first, status: 'completed' })
    await run(id, { type: 'save-service', id: assessment.id, name: assessment.name, name_en: assessment.name_en, durationMin: 75, priceCents: 20_000, active: true })
    await run(id, { type: 'save-resource', id: randomUUID(), name: '理疗三室', name_en: 'Treatment room 3', kind: 'room', color: '#4F8DB8', active: true })
    await run(id, { type: 'set-hours', weekday: 0, opens: '10:00', closes: '16:00' })
    await run(id, { type: 'set-hours', weekday: 0, opens: '11:00', closes: '15:00' })
    await run(id, { type: 'close-day', weekday: 6 })

    const data = await read(id)
    const moved = data.bookings.find((b) => b.id === first)!
    // The edit recomputed the end from the new service and took its price.
    expect([moved.status, moved.ends_at, moved.price_cents]).toEqual(['completed', new Date(at('10:30')).toISOString(), 7_000])
    const second = data.bookings.find((b) => b.id === clash.id)!
    expect(second.ends_at).toBe(new Date(at('11:30')).toISOString())
    expect(second.price_cents).toBe(18_000) // booked before the price rise
    expect(data.customers.find((c) => c.id === customer)?.name).toBe('Ada Lovelace')
    expect(data.services.find((s) => s.id === assessment.id)).toMatchObject({ duration_min: 75, price_cents: 20_000 })
    expect(data.resources.find((r) => r.name_en === 'Treatment room 3')?.color).toBe('#4f8db8')
    expect(data.opening_hours.map((h) => [h.weekday, h.opens, h.closes])).toEqual([
      [0, '11:00', '15:00'], [1, '09:00', '19:00'], [2, '09:00', '19:00'], [3, '09:00', '19:00'], [4, '09:00', '19:00'], [5, '09:00', '19:00'],
    ])
  })

  test('raw SQL as the project role cannot double-book; adjacent, other-resource and cancelled bookings are fine', async () => {
    const { id, resource, service, customer } = await fixture()
    const lin = resource('Dr. Lin')
    const s = service('Follow-up treatment').id
    const first = await insertBooking(id, { resource: lin, service: s, customer, from: '14:00' })
    expect(new Date(first.rows[0].ends_at).toISOString()).toBe(new Date(at('14:45')).toISOString())
    expect(Number(first.rows[0].price_cents)).toBe(12_000)
    for (const [from, to] of [['14:00', '14:45'], ['13:30', '14:01'], ['14:44', '15:30'], ['13:00', '16:00'], ['14:10', '14:20']])
      await expect(insertBooking(id, { resource: lin, service: s, customer, from, to })).rejects.toThrow('booking_overlap')
    await insertBooking(id, { resource: lin, service: s, customer, from: '13:15', to: '14:00' })
    await insertBooking(id, { resource: lin, service: s, customer, from: '14:45' })
    await insertBooking(id, { resource: resource('Zoe Zhou'), service: s, customer, from: '14:00' })
    // A cancelled booking neither blocks nor is blocked.
    await insertBooking(id, { resource: lin, service: s, customer, from: '14:00', status: 'cancelled' })
    await asProject(id, (c, t) => c.query(`UPDATE ${t('bookings')} SET status='cancelled' WHERE id=$1`, [first.rows[0].id]))
    const again = await insertBooking(id, { resource: lin, service: s, customer, from: '14:00' })
    // Moving into someone else's slot is an overlap too.
    await expect(
      asProject(id, (c, t) => c.query(`UPDATE ${t('bookings')} SET starts_at=$2, ends_at=$3 WHERE id=$1`, [again.rows[0].id, at('13:30'), at('14:15')])),
    ).rejects.toThrow('booking_overlap')
    // The rule cannot be dodged under REPEATABLE READ, where the search would miss a concurrent booking.
    await expect(
      asProject(id, async (c, t) => {
        await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        await c.query(`INSERT INTO ${t('bookings')}(resource_id,service_id,customer_id,starts_at) VALUES($1,$2,$3,$4)`, [lin, s, customer, at('17:00')])
      }),
    ).rejects.toThrow('booking_isolation')
  })

  test('two overlapping inserts in concurrent transactions: exactly one commits', async () => {
    const { id, resource, service, customer } = await fixture()
    const lin = resource('Dr. Lin')
    const s = service('Initial assessment').id
    const begin = async () => {
      const c = await pool.connect()
      await c.query('BEGIN')
      await c.query(`SET LOCAL ROLE "${roleFor(id)}"`)
      return c
    }
    const insert = (c: PoolClient, from: string) =>
      c.query(`INSERT INTO "${schemaFor(id)}"."bookings"(resource_id,service_id,customer_id,starts_at) VALUES($1,$2,$3,$4)`, [lin, s, customer, at(from)])

    // Interleaved by hand: the second writer waits on the resource lock, then sees the first.
    const a = await begin()
    const b = await begin()
    try {
      await insert(a, '09:00')
      const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const blocked = insert(b, '09:30').then(
        () => 'committed',
        (e: Error) => e.message,
      )
      let waiting = false
      for (let i = 0; i < 50 && !waiting; i++) {
        const r = await pool.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1`, [pid])
        waiting = r.rows[0]?.wait_event_type === 'Lock'
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(waiting).toBe(true)
      await a.query('COMMIT')
      expect(await blocked).toBe('booking_overlap')
      await b.query('ROLLBACK')
    } finally {
      a.release()
      b.release()
    }

    // And as a plain race, several times over: one winner per slot, never two.
    for (const from of ['11:00', '13:00', '15:00']) {
      const attempt = async () => {
        const c = await begin()
        try {
          await insert(c, from)
          await c.query('COMMIT')
          return 'committed'
        } catch (e) {
          await c.query('ROLLBACK')
          return (e as Error).message
        } finally {
          c.release()
        }
      }
      const results = await Promise.all([attempt(), attempt(), attempt()])
      expect(results.filter((r) => r === 'committed')).toHaveLength(1)
      expect(results.filter((r) => r === 'booking_overlap')).toHaveLength(2)
    }
    const rows = await pool.query(`SELECT count(*)::int AS n FROM "${schemaFor(id)}"."bookings" WHERE resource_id=$1 AND starts_at >= $2 AND starts_at < $3`, [lin, at('00:00'), at('23:59')])
    expect(rows.rows[0].n).toBe(4)
  })

  test('constraints reject impossible rows', async () => {
    const { id, resource, service, customer } = await fixture()
    const lin = resource('Dr. Lin')
    const s = service('Follow-up treatment').id
    await expect(insertBooking(id, { resource: lin, service: s, customer, from: '10:00', to: '09:00' })).rejects.toThrow('bookings_positive_length')
    await expect(insertBooking(id, { resource: lin, service: s, customer, from: '10:00', to: '10:00' })).rejects.toThrow('bookings_positive_length')
    await expect(insertBooking(id, { resource: lin, service: s, customer, from: '00:00', to: '13:00' })).rejects.toThrow('bookings_max_length')
    await expect(insertBooking(id, { resource: lin, service: s, customer, from: '10:00', status: 'maybe' })).rejects.toThrow('check constraint')
    const rejects = (statement: string, params: unknown[] = []) =>
      expect(asProject(id, (c, t) => c.query(statement.replace(/\{(\w+)\}/g, (_, n) => t(n)), params))).rejects.toThrow()
    await rejects(`INSERT INTO {services}(name,duration_min,price_cents) VALUES('x',47,100)`)
    await rejects(`INSERT INTO {services}(name,duration_min,price_cents) VALUES('x',600,100)`)
    await rejects(`INSERT INTO {services}(name,duration_min,price_cents) VALUES('x',30,100.5)`)
    await rejects(`INSERT INTO {services}(name,duration_min,price_cents) VALUES('x',30,-1)`)
    await rejects(`INSERT INTO {services}(name,duration_min,price_cents) VALUES('  ',30,100)`)
    await rejects(`INSERT INTO {resources}(name,kind,color) VALUES('x','robot','#aabbcc')`)
    await rejects(`INSERT INTO {resources}(name,kind,color) VALUES('x','room','teal')`)
    await rejects(`INSERT INTO {opening_hours}(weekday,opens,closes) VALUES(0,'18:00','09:00')`)
    await rejects(`INSERT INTO {opening_hours}(weekday,opens,closes) VALUES(7,'09:00','18:00')`)
    await rejects(`INSERT INTO {opening_hours}(weekday,opens,closes) VALUES(0,'9:00','18:00')`)
    await rejects(`INSERT INTO {opening_hours}(weekday,opens,closes) VALUES(1,'09:00','18:00')`) // one row per weekday
    await rejects(`INSERT INTO {customers}(name) VALUES('')`)
    // Deactivated resources and services take no new bookings, but their history stays editable.
    await asProject(id, (c, t) => c.query(`UPDATE ${t('resources')} SET active=false WHERE id=$1`, [lin]))
    await expect(insertBooking(id, { resource: lin, service: s, customer, from: '10:00' })).rejects.toThrow('resource_inactive')
    await asProject(id, (c, t) => c.query(`UPDATE ${t('services')} SET active=false WHERE id=$1`, [s]))
    await expect(insertBooking(id, { resource: resource('Zoe Zhou'), service: s, customer, from: '10:00' })).rejects.toThrow('service_inactive')
    await asProject(id, (c, t) => c.query(`UPDATE ${t('bookings')} SET notes='still editable' WHERE resource_id=$1`, [lin]))
    // A booking still points at a customer: they cannot be deleted from under it.
    await expect(asProject(id, (c, t) => c.query(`DELETE FROM ${t('customers')} WHERE id=$1`, [customer]))).rejects.toThrow('foreign key')
  })

  test('the gallery demo is read-only: its role can read but not write', async () => {
    const demoId = await templates.ensureDemo('booking')
    const demo = (await templates.readTables(demoId, 'booking')) as unknown as BookingData
    expect(demo.readOnly).toBe(true)
    expect(demo.bookings.length).toBeGreaterThan(300)
    expect((await read(demoId)).bookings).toHaveLength(demo.bookings.length)
    const b = demo.bookings[0]
    for (const action of [
      { type: 'set-status', id: b.id, status: 'cancelled' },
      { type: 'book', id: randomUUID(), resourceId: b.resource_id, serviceId: b.service_id, customerId: b.customer_id, startsAt: at('10:00'), notes: '' },
      { type: 'close-day', weekday: 1 },
    ] satisfies BookingAction[]) {
      const statement = statementFor(action)
      const error = await asProject(demoId, (c) => c.query(`SET LOCAL search_path = "${schemaFor(demoId)}"`).then(() => c.query(statement.sql, statement.params))).catch((e: Error) => e)
      expect(errorKey((error as Error).message)).toBe('read_only')
    }
    expect(((await templates.readTables(demoId, 'booking')) as unknown as BookingData).opening_hours).toHaveLength(6)
  })
})
