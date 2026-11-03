import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import type { IR, Field } from '@lovbase/core/ir'
import { irToDDL, qi } from '@lovbase/core/ddl'
import { DEMO_HISTORY_DAYS, MAX_BOOKING_HOURS, MAX_DURATION, MAX_PRICE_CENTS, MIN_DURATION } from '@lovbase/core/booking'

type Definition = [string, string, Array<[string, Field['type'], string?]>]
const definitions: Definition[] = [
  [
    'resources',
    '资源',
    [
      ['name', 'text'],
      ['name_en', 'text'],
      ['kind', 'select', 'staff,room'],
      ['color', 'text'],
      ['active', 'boolean'],
    ],
  ],
  [
    'services',
    '服务项目',
    [
      ['name', 'text'],
      ['name_en', 'text'],
      ['duration_min', 'number'],
      ['price_cents', 'number'],
      ['active', 'boolean'],
    ],
  ],
  [
    'customers',
    '客户',
    [
      ['name', 'text'],
      ['phone', 'text'],
      ['email', 'text'],
      ['notes', 'text'],
    ],
  ],
  [
    'bookings',
    '预约',
    [
      ['resource_id', 'link', 'resources'],
      ['service_id', 'link', 'services'],
      ['customer_id', 'link', 'customers'],
      ['starts_at', 'date'],
      ['ends_at', 'date'],
      ['status', 'select', 'confirmed,completed,cancelled,no_show'],
      ['price_cents', 'number'],
      ['notes', 'text'],
    ],
  ],
  [
    'opening_hours',
    '营业时间',
    [
      ['weekday', 'number'],
      ['opens', 'text'],
      ['closes', 'text'],
    ],
  ],
]
export const bookingIR: IR = {
  version: 1,
  appName: 'Bookings',
  entities: definitions.map(([dbName, name, fields]) => ({
    id: dbName,
    dbName,
    name,
    fields: fields.map(([field, type, extra]) => ({
      id: `${dbName}_${field}`,
      dbName: field,
      name: field,
      type,
      required: false,
      ...(type === 'link' ? { linkTo: extra } : {}),
      ...(type === 'select' ? { options: extra!.split(',') } : {}),
    })),
  })),
}

const whole = (column: string, min: number, max: number) =>
  `CHECK(${column} = trunc(${column}) AND ${column} BETWEEN ${min} AND ${max})`
const clock = (column: string) => `CHECK(${column} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')`

/**
 * The scheduling rules live in the database, not in the app: a copy writes through the generic
 * SQL API, the owner can rewrite the app, and anyone can type into the SQL console. All of them
 * meet the same constraints and the same no-double-booking trigger.
 */
export async function installBooking(c: pg.PoolClient, schema: string) {
  await c.query(irToDDL(bookingIR, schema))
  const s = qi(schema)
  const table = (name: string) => `${s}.${qi(name)}`
  await c.query(`ALTER TABLE ${table('resources')}
    ALTER COLUMN name SET NOT NULL, ALTER COLUMN name_en SET NOT NULL, ALTER COLUMN name_en SET DEFAULT '',
    ALTER COLUMN kind SET NOT NULL, ALTER COLUMN color SET NOT NULL, ALTER COLUMN color SET DEFAULT '#3d8f86',
    ALTER COLUMN active SET NOT NULL, ALTER COLUMN active SET DEFAULT true,
    ADD CHECK(length(btrim(name)) BETWEEN 1 AND 120), ADD CHECK(kind IN ('staff','room')),
    ADD CHECK(color ~ '^#[0-9a-f]{6}$')`)
  await c.query(`ALTER TABLE ${table('services')}
    ALTER COLUMN name SET NOT NULL, ALTER COLUMN name_en SET NOT NULL, ALTER COLUMN name_en SET DEFAULT '',
    ALTER COLUMN duration_min SET NOT NULL, ALTER COLUMN price_cents SET NOT NULL,
    ALTER COLUMN active SET NOT NULL, ALTER COLUMN active SET DEFAULT true,
    ADD CHECK(length(btrim(name)) BETWEEN 1 AND 120),
    ADD ${whole('duration_min', MIN_DURATION, MAX_DURATION)}, ADD CHECK(duration_min % 5 = 0),
    ADD ${whole('price_cents', 0, MAX_PRICE_CENTS)}`)
  await c.query(`ALTER TABLE ${table('customers')}
    ALTER COLUMN name SET NOT NULL, ALTER COLUMN phone SET NOT NULL, ALTER COLUMN phone SET DEFAULT '',
    ALTER COLUMN email SET NOT NULL, ALTER COLUMN email SET DEFAULT '',
    ALTER COLUMN notes SET NOT NULL, ALTER COLUMN notes SET DEFAULT '',
    ADD CHECK(length(btrim(name)) BETWEEN 1 AND 120), ADD CHECK(length(phone) <= 40), ADD CHECK(length(email) <= 200)`)
  await c.query(`ALTER TABLE ${table('bookings')}
    ALTER COLUMN resource_id SET NOT NULL, ALTER COLUMN service_id SET NOT NULL, ALTER COLUMN customer_id SET NOT NULL,
    ALTER COLUMN starts_at SET NOT NULL, ALTER COLUMN ends_at SET NOT NULL, ALTER COLUMN price_cents SET NOT NULL,
    ALTER COLUMN status SET NOT NULL, ALTER COLUMN status SET DEFAULT 'confirmed',
    ALTER COLUMN notes SET NOT NULL, ALTER COLUMN notes SET DEFAULT '',
    ADD CHECK(status IN ('confirmed','completed','cancelled','no_show')),
    ADD CONSTRAINT bookings_positive_length CHECK(ends_at > starts_at),
    ADD CONSTRAINT bookings_max_length CHECK(ends_at - starts_at <= interval '${MAX_BOOKING_HOURS} hours'),
    ADD ${whole('price_cents', 0, MAX_PRICE_CENTS)}`)
  await c.query(`ALTER TABLE ${table('opening_hours')}
    ALTER COLUMN weekday SET NOT NULL, ALTER COLUMN opens SET NOT NULL, ALTER COLUMN closes SET NOT NULL,
    ADD ${whole('weekday', 0, 6)}, ADD UNIQUE(weekday),
    ADD ${clock('opens')}, ADD ${clock('closes')}, ADD CHECK(closes > opens)`)
  await c.query(`CREATE INDEX ON ${table('bookings')}(resource_id, starts_at)`)
  await c.query(`CREATE INDEX ON ${table('bookings')}(customer_id)`)
  await c.query(`CREATE INDEX ON ${table('bookings')}(starts_at)`)

  // No double booking. An exclusion constraint would need btree_gist, which a hosted database may
  // not offer, so a trigger does it: lock the resource row, then look for an overlap. A second
  // writer for the same resource waits on that lock until the first commits, and its own check
  // then runs on a fresh snapshot (each statement in a READ COMMITTED transaction gets one), so
  // it sees the first booking and fails. Writers for different resources never wait on each other.
  await c.query(`CREATE FUNCTION ${s}.booking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE service record; clash record;
    BEGIN
      IF NEW.ends_at IS NULL OR NEW.price_cents IS NULL THEN
        SELECT duration_min, price_cents INTO service FROM ${table('services')} WHERE id = NEW.service_id;
        IF FOUND THEN
          NEW.ends_at := coalesce(NEW.ends_at, NEW.starts_at + make_interval(mins => service.duration_min::int));
          NEW.price_cents := coalesce(NEW.price_cents, service.price_cents);
        END IF;
      END IF;
      IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
      IF TG_OP = 'INSERT' THEN
        IF EXISTS (SELECT 1 FROM ${table('resources')} WHERE id = NEW.resource_id AND NOT active) THEN
          RAISE EXCEPTION 'resource_inactive' USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM ${table('services')} WHERE id = NEW.service_id AND NOT active) THEN
          RAISE EXCEPTION 'service_inactive' USING ERRCODE = 'check_violation';
        END IF;
      -- Checking out or adding a note leaves the slot as it was: no lock, no search.
      ELSIF OLD.status <> 'cancelled' AND NEW.resource_id = OLD.resource_id
        AND NEW.starts_at = OLD.starts_at AND NEW.ends_at = OLD.ends_at THEN
        RETURN NEW;
      END IF;
      -- Under REPEATABLE READ the search would use the snapshot taken before the wait and miss
      -- the booking it waited for. (SERIALIZABLE is safe: it aborts one of the two instead.)
      IF current_setting('transaction_isolation') = 'repeatable read' THEN
        RAISE EXCEPTION 'booking_isolation' USING ERRCODE = 'object_not_in_prerequisite_state',
          HINT = 'Write bookings in a READ COMMITTED or SERIALIZABLE transaction.';
      END IF;
      PERFORM 1 FROM ${table('resources')} WHERE id = NEW.resource_id FOR UPDATE;
      -- The half-open overlap test, tstzrange(starts_at, ends_at) && tstzrange(NEW.starts_at,
      -- NEW.ends_at), spelled out so the (resource_id, starts_at) index can serve it.
      SELECT id, starts_at, ends_at INTO clash FROM ${table('bookings')}
        WHERE resource_id = NEW.resource_id AND status <> 'cancelled' AND id <> NEW.id
          AND starts_at < NEW.ends_at AND ends_at > NEW.starts_at
          AND starts_at > NEW.starts_at - interval '${MAX_BOOKING_HOURS} hours'
        LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'booking_overlap' USING ERRCODE = 'exclusion_violation',
          DETAIL = format('Overlaps booking %s, %s to %s.', clash.id, clash.starts_at, clash.ends_at);
      END IF;
      RETURN NEW;
    END $$`)
  await c.query(`CREATE TRIGGER no_double_booking BEFORE INSERT OR UPDATE ON ${table('bookings')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.booking_guard()`)
}

/** Deterministic, so every demo and every copy starts from the same believable six weeks. */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

/** The demo studio is in Shanghai: UTC+8 all year round. */
const STUDIO_OFFSET_MS = 8 * 3_600_000

export async function seedBooking(c: pg.PoolClient, schema: string, today = new Date()) {
  const insert = async (table: string, row: Record<string, unknown>) => {
    const entries = Object.entries(row)
    await c.query(
      `INSERT INTO ${qi(schema)}.${qi(table)} (${entries.map(([key]) => qi(key)).join(',')}) VALUES (${entries.map((_, i) => '$' + (i + 1)).join(',')})`,
      entries.map(([, value]) => value),
    )
  }
  let order = 0
  // Staggered by a millisecond so lists keep the order the rows are written in here.
  const stamp = () => new Date(today.getTime() - 60_000 + order++).toISOString()

  const hours: Record<number, [string, string]> = {
    1: ['09:00', '19:00'], 2: ['09:00', '19:00'], 3: ['09:00', '19:00'], 4: ['09:00', '19:00'],
    5: ['09:00', '19:00'], 6: ['10:00', '17:00'],
  }
  for (const [weekday, [opens, closes]] of Object.entries(hours))
    await insert('opening_hours', { id: randomUUID(), created_at: stamp(), weekday: Number(weekday), opens, closes })

  const resource = async (name: string, name_en: string, kind: 'staff' | 'room', color: string) => {
    const row = { id: randomUUID(), created_at: stamp(), name, name_en, kind, color, active: true }
    await insert('resources', row)
    return row
  }
  const lin = await resource('林医生', 'Dr. Lin', 'staff', '#3d8f86')
  const zhou = await resource('周晓', 'Zoe Zhou', 'staff', '#d27f57')
  const chen = await resource('马可', 'Marco Ruiz', 'staff', '#7682c6')
  const room = await resource('理疗二室', 'Treatment room 2', 'room', '#b2973f')

  const service = async (name: string, name_en: string, duration_min: number, price_cents: number, active = true) => {
    const row = { id: randomUUID(), created_at: stamp(), name, name_en, duration_min, price_cents, active }
    await insert('services', row)
    return row
  }
  const assessment = await service('初诊评估', 'Initial assessment', 60, 18_000)
  const followUp = await service('复诊理疗', 'Follow-up treatment', 45, 12_000)
  const rehab = await service('运动康复训练', 'Sports rehab session', 60, 14_000)
  const massage = await service('深层组织按摩', 'Deep tissue massage', 90, 16_000)
  const release = await service('筋膜放松', 'Myofascial release', 30, 7_000)
  const shockwave = await service('冲击波治疗', 'Shockwave therapy', 30, 11_000)
  await service('体态筛查', 'Posture screening', 45, 9_500, false)

  const names = [
    'Ava Thompson', 'Lucas Moreau', 'Mia Okafor', 'Noah Fischer', 'Isabella Rossi', 'Ethan Brooks', 'Priya Patel', 'Mateo Garcia', 'Hannah Schmidt', 'Omar Haddad',
    'Emily Zhang', 'Kevin Wu', 'Sophie Chen', 'Daniel Li', 'Grace Huang', 'Ryan Xu', 'Olivia Sun', 'Jason Ma',
    'Sofia Almeida', 'James Walsh', 'Amara Nwosu', 'Felix Novak', 'Lena Berg', 'Diego Herrera', 'Yuki Tanaka', 'Aisha Rahman', 'Tom Becker', 'Nina Petrova',
    'Chloe Zhou', 'Leo Lin', 'Camila Santos', 'Oliver Hughes', 'Zara Khan', 'Elias Lindqvist', 'Maya Cohen', 'Arjun Mehta', 'Clara Dubois', 'Samuel Adeyemi', 'Ingrid Olsen', 'Rafael Costa',
  ]
  const customerNotes: Record<number, string> = {
    0: 'Six weeks after left knee surgery',
    3: 'Prefers afternoons',
    11: 'Training for a marathon',
    14: 'Prefers a female therapist',
    22: 'Allergic to massage oils',
  }
  const customers: string[] = []
  for (const [i, name] of names.entries()) {
    const id = randomUUID()
    customers.push(id)
    await insert('customers', {
      id,
      created_at: stamp(),
      name,
      // Fictional: 555-01xx is the range reserved for fiction, never assigned.
      phone: `+1 415 555 01${String(i).padStart(2, '0')}`,
      email: `${name.toLowerCase().replace(' ', '.')}@example.com`,
      notes: customerNotes[i] ?? '',
    })
  }

  // What each resource tends to be booked for; repeats weight the draw.
  const mix = new Map<string, (typeof assessment)[]>([
    [lin.id, [assessment, assessment, followUp, followUp, rehab]],
    [zhou.id, [massage, release, followUp, massage, release]],
    [chen.id, [rehab, rehab, followUp, release, assessment]],
    [room.id, [shockwave, shockwave, release]],
  ])
  const bookingNotes = ['Limited right shoulder mobility', 'Runner’s knee', 'Lower back pain', 'Tennis elbow']
  const rand = random(20261103)
  const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)]
  const studioToday = new Date(today.getTime() + STUDIO_OFFSET_MS).toISOString().slice(0, 10)
  const instant = (day: string, minutes: number) => new Date(Date.parse(day + 'T00:00:00Z') + minutes * 60_000 - STUDIO_OFFSET_MS)
  const clockMinutes = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3))
  const busy = new Map<string, [number, number][]>()

  for (let offset = -DEMO_HISTORY_DAYS; offset <= 14; offset++) {
    const day = new Date(Date.parse(studioToday + 'T00:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10)
    const open = hours[new Date(day + 'T00:00:00Z').getUTCDay()]
    if (!open) continue
    const [opens, closes] = open.map(clockMinutes)
    for (const r of [lin, zhou, chen, room]) {
      // Fuller in the past than further ahead, the way a diary fills up.
      const usual = r === room ? 2 + Math.floor(rand() * 2) : 4 + Math.floor(rand() * 3)
      const count = offset <= 0 ? usual : Math.max(1, Math.round(usual * Math.max(0.3, 1 - offset / 16)))
      let cursor = opens + pick([0, 0, 30, 60])
      for (let i = 0; i < count; i++) {
        const s = pick(mix.get(r.id)!)
        const start = cursor + (i === 0 ? 0 : pick([0, 0, 15, 15, 30, 45, 60, 90]))
        if (start + s.duration_min > closes) break
        cursor = start + s.duration_min
        const startsAt = instant(day, start)
        const endsAt = instant(day, cursor)
        // Regulars come back: the draw leans towards the front of the list. Nobody is in two
        // places at once.
        let customer = ''
        for (let tries = 0; tries < 6 && !customer; tries++) {
          const candidate = customers[Math.floor(rand() ** 1.7 * customers.length)]
          const spans = busy.get(candidate) ?? []
          if (!spans.some(([a, b]) => a < endsAt.getTime() && startsAt.getTime() < b)) customer = candidate
        }
        if (!customer) continue
        busy.set(customer, [...(busy.get(customer) ?? []), [startsAt.getTime(), endsAt.getTime()]])
        const roll = rand()
        const status =
          endsAt <= today ? (roll < 0.07 ? 'no_show' : roll < 0.14 ? 'cancelled' : 'completed') : roll < 0.06 ? 'cancelled' : 'confirmed'
        const notes =
          s === assessment && rand() < 0.5 ? 'First visit' : rand() < 0.08 ? pick(bookingNotes) : ''
        const lead = (1 + Math.floor(rand() * 10)) * 86_400_000
        await insert('bookings', {
          id: randomUUID(),
          created_at: new Date(Math.min(startsAt.getTime() - lead, today.getTime() - 120_000)).toISOString(),
          resource_id: r.id,
          service_id: s.id,
          customer_id: customer,
          starts_at: startsAt.toISOString(),
          status,
          notes,
        })
      }
    }
  }
}
