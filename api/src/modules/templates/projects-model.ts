import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import type { IR, Field } from '@lovbase/core/ir'
import { irToDDL, qi } from '@lovbase/core/ddl'
import { POSITION_STEP, priorities, statuses, type Priority, type Status } from '@lovbase/core/projects'

type Definition = [string, string, Array<[string, Field['type'], string?]>]
const definitions: Definition[] = [
  [
    'members',
    '成员',
    [
      ['name', 'text'],
      ['role', 'text'],
      ['color', 'text'],
    ],
  ],
  [
    'projects',
    '项目',
    [
      ['name', 'text'],
      ['key', 'text'],
      ['description', 'text'],
      ['color', 'text'],
      ['archived', 'boolean'],
    ],
  ],
  [
    'tasks',
    '任务',
    [
      ['project_id', 'link', 'projects'],
      ['number', 'number'],
      ['title', 'text'],
      ['description', 'text'],
      ['status', 'select', statuses.join(',')],
      ['priority', 'select', 'low,medium,high,urgent'],
      ['assignee_id', 'link', 'members'],
      ['points', 'number'],
      ['due_on', 'text'],
      ['position', 'number'],
      ['completed_at', 'date'],
    ],
  ],
  [
    'comments',
    '评论',
    [
      ['task_id', 'link', 'tasks'],
      ['author_id', 'link', 'members'],
      ['body', 'text'],
    ],
  ],
  [
    'task_events',
    '任务动态',
    [
      ['task_id', 'link', 'tasks'],
      ['kind', 'select', 'created,status,assignee'],
      ['from_value', 'text'],
      ['to_value', 'text'],
      ['at', 'date'],
    ],
  ],
]
export const projectsIR: IR = {
  version: 1,
  appName: 'Project Board',
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

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',')
const day = (column: string) => `${column} ~ '^\\d{4}-\\d{2}-\\d{2}$' AND ${column}::date IS NOT NULL`

/**
 * The board's bookkeeping lives in the database, so a write from the app, the SQL console or an
 * app the owner later rewrites gets the same task numbers, completion times and history.
 */
export async function installProjects(c: pg.PoolClient, schema: string) {
  await c.query(irToDDL(projectsIR, schema))
  const s = qi(schema)
  const table = (name: string) => `${s}.${qi(name)}`
  await c.query(`ALTER TABLE ${table('members')}
    ALTER COLUMN name SET NOT NULL, ALTER COLUMN role SET NOT NULL, ALTER COLUMN role SET DEFAULT '',
    ALTER COLUMN color SET NOT NULL, ALTER COLUMN color SET DEFAULT '#71717a',
    ADD CHECK(char_length(btrim(name)) BETWEEN 1 AND 80), ADD CHECK(color ~ '^#[0-9a-fA-F]{6}$')`)
  await c.query(`ALTER TABLE ${table('projects')}
    ALTER COLUMN name SET NOT NULL, ALTER COLUMN key SET NOT NULL,
    ALTER COLUMN description SET NOT NULL, ALTER COLUMN description SET DEFAULT '',
    ALTER COLUMN color SET NOT NULL, ALTER COLUMN color SET DEFAULT '#5e5ce6',
    ALTER COLUMN archived SET NOT NULL, ALTER COLUMN archived SET DEFAULT false,
    ADD CHECK(char_length(btrim(name)) BETWEEN 1 AND 80), ADD CHECK(key ~ '^[A-Z][A-Z0-9]{1,5}$'),
    ADD CHECK(color ~ '^#[0-9a-fA-F]{6}$'), ADD UNIQUE(key)`)
  await c.query(`ALTER TABLE ${table('tasks')}
    ALTER COLUMN project_id SET NOT NULL, ALTER COLUMN number SET NOT NULL, ALTER COLUMN title SET NOT NULL,
    ALTER COLUMN description SET NOT NULL, ALTER COLUMN description SET DEFAULT '',
    ALTER COLUMN status SET NOT NULL, ALTER COLUMN status SET DEFAULT 'todo',
    ALTER COLUMN priority SET NOT NULL, ALTER COLUMN priority SET DEFAULT 'medium',
    ALTER COLUMN position SET NOT NULL,
    ADD CHECK(number > 0 AND number = trunc(number)),
    ADD CHECK(char_length(btrim(title)) BETWEEN 1 AND 200), ADD CHECK(char_length(description) <= 4000),
    ADD CHECK(status IN (${list(statuses)})), ADD CHECK(priority IN (${list(priorities)})),
    ADD CHECK(points IS NULL OR points IN (0,1,2,3,5,8,13)),
    ADD CHECK(due_on IS NULL OR (${day('due_on')})),
    ADD CHECK((status = 'done') = (completed_at IS NOT NULL)),
    ADD UNIQUE(project_id, number)`)
  await c.query(`ALTER TABLE ${table('comments')}
    ALTER COLUMN task_id SET NOT NULL, ALTER COLUMN body SET NOT NULL,
    ADD CHECK(char_length(btrim(body)) BETWEEN 1 AND 4000)`)
  await c.query(`ALTER TABLE ${table('task_events')}
    ALTER COLUMN task_id SET NOT NULL, ALTER COLUMN kind SET NOT NULL,
    ALTER COLUMN at SET NOT NULL, ALTER COLUMN at SET DEFAULT now(),
    ADD CHECK(kind IN ('created','status','assignee'))`)
  // A task takes its comments and history with it; a departed member leaves tasks unassigned.
  await c.query(`ALTER TABLE ${table('comments')}
    DROP CONSTRAINT comments_task_id_fkey, ADD FOREIGN KEY(task_id) REFERENCES ${table('tasks')}(id) ON DELETE CASCADE,
    DROP CONSTRAINT comments_author_id_fkey, ADD FOREIGN KEY(author_id) REFERENCES ${table('members')}(id) ON DELETE SET NULL`)
  await c.query(`ALTER TABLE ${table('task_events')}
    DROP CONSTRAINT task_events_task_id_fkey, ADD FOREIGN KEY(task_id) REFERENCES ${table('tasks')}(id) ON DELETE CASCADE`)
  await c.query(`ALTER TABLE ${table('tasks')}
    DROP CONSTRAINT tasks_assignee_id_fkey, ADD FOREIGN KEY(assignee_id) REFERENCES ${table('members')}(id) ON DELETE SET NULL`)
  await c.query(`CREATE INDEX ON ${table('tasks')}(project_id, status, position)`)
  await c.query(`CREATE INDEX ON ${table('tasks')}(assignee_id)`)
  await c.query(`CREATE INDEX ON ${table('comments')}(task_id)`)
  await c.query(`CREATE INDEX ON ${table('task_events')}(task_id, at)`)

  // Before a write: number new tasks, keep identity fixed, stamp completion.
  await c.query(`CREATE FUNCTION ${s}.projects_task_before() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE archived boolean;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        -- Locking the project row queues concurrent inserts into one project, so the max below
        -- (a fresh snapshot per statement under READ COMMITTED) already sees the previous winner.
        SELECT p.archived INTO archived FROM ${table('projects')} p WHERE p.id = NEW.project_id FOR NO KEY UPDATE;
        IF archived THEN RAISE EXCEPTION 'project_archived' USING ERRCODE = 'check_violation'; END IF;
        SELECT coalesce(max(t.number), 0) + 1 INTO NEW.number FROM ${table('tasks')} t WHERE t.project_id = NEW.project_id;
        IF NEW.position IS NULL THEN
          SELECT coalesce(max(t.position), 0) + ${POSITION_STEP} INTO NEW.position FROM ${table('tasks')} t
            WHERE t.project_id = NEW.project_id AND t.status = NEW.status;
        END IF;
      ELSIF NEW.number IS DISTINCT FROM OLD.number OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
        RAISE EXCEPTION 'task_identity_locked' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.status <> 'done' THEN
        NEW.completed_at := NULL;
      ELSIF TG_OP = 'INSERT' OR OLD.status <> 'done' THEN
        NEW.completed_at := now();
      ELSE
        NEW.completed_at := OLD.completed_at;
      END IF;
      RETURN NEW;
    END $$`)
  await c.query(`CREATE TRIGGER task_before BEFORE INSERT OR UPDATE ON ${table('tasks')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.projects_task_before()`)
  // After a write: the history the activity feed and cycle-time report read.
  await c.query(`CREATE FUNCTION ${s}.projects_task_history() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO ${table('task_events')}(task_id, kind, to_value) VALUES (NEW.id, 'created', NEW.status);
        RETURN NULL;
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO ${table('task_events')}(task_id, kind, from_value, to_value) VALUES (NEW.id, 'status', OLD.status, NEW.status);
      END IF;
      IF NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN
        INSERT INTO ${table('task_events')}(task_id, kind, from_value, to_value)
          VALUES (NEW.id, 'assignee', OLD.assignee_id::text, NEW.assignee_id::text);
      END IF;
      RETURN NULL;
    END $$`)
  await c.query(`CREATE TRIGGER task_history AFTER INSERT OR UPDATE ON ${table('tasks')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.projects_task_history()`)
  // History is append-only: an event cannot be edited, and only leaves along with its task.
  await c.query(`CREATE FUNCTION ${s}.projects_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM ${table('tasks')} t WHERE t.id = OLD.task_id) THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'history_append_only' USING ERRCODE = 'check_violation';
    END $$`)
  await c.query(`CREATE TRIGGER history_guard BEFORE UPDATE OR DELETE ON ${table('task_events')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.projects_history_guard()`)
}

const iso = (ms: number) => new Date(ms).toISOString()

/** Deterministic, so every demo and every copy starts from the same believable eight weeks. */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

type Plan = [project: 'WEB' | 'MOB' | 'API', title: string, status: Status, priority: Priority, assignee: number | null, points: number | null]
// Done tasks are listed oldest completion first; open ones in no particular order.
const plans: Plan[] = [
  ['WEB', 'Audit current marketing site for broken links', 'done', 'medium', 4, 2],
  ['API', 'Draft v1 resource naming guidelines', 'done', 'high', 2, 3],
  ['MOB', 'Set up crash reporting in the beta build', 'done', 'high', 3, 2],
  ['WEB', 'Define type scale and spacing tokens', 'done', 'high', 1, 3],
  ['API', 'Rate limiter middleware with per-key buckets', 'done', 'urgent', 2, 5],
  ['MOB', 'Migrate navigation to stack + tab layout', 'done', 'medium', 3, 5],
  ['WEB', 'Hero section with product screenshot carousel', 'done', 'high', 1, 5],
  ['API', 'Pagination with opaque cursors on list endpoints', 'done', 'high', 5, 5],
  ['WEB', 'Pricing page layout and plan comparison table', 'done', 'medium', 4, 3],
  ['MOB', 'Offline queue for drafts created without signal', 'done', 'high', 3, 8],
  ['API', 'Idempotency keys for POST requests', 'done', 'urgent', 2, 5],
  ['WEB', 'Replace legacy analytics snippet', 'done', 'low', 5, 1],
  ['MOB', 'Dark mode color pass on settings screens', 'done', 'low', 4, 2],
  ['WEB', 'Customer logos strip with lazy-loaded images', 'done', 'medium', 1, 2],
  ['API', 'Webhook signature verification docs', 'done', 'medium', 0, 2],
  ['MOB', 'Biometric unlock on iOS and Android', 'done', 'high', 3, 5],
  ['WEB', 'Blog index with tag filters', 'done', 'medium', 5, 3],
  ['API', 'OpenAPI spec generated from route schemas', 'done', 'high', 2, 8],
  ['WEB', 'Accessible mobile navigation drawer', 'done', 'high', 1, 3],
  ['MOB', 'Push notification permission primer screen', 'done', 'medium', 4, 2],
  ['API', 'Error envelope with stable machine codes', 'done', 'high', 5, 3],
  ['WEB', 'Contact sales form with spam protection', 'done', 'medium', 5, 3],
  ['MOB', 'Image upload with resumable chunks', 'done', 'urgent', 3, 8],
  ['WEB', 'Lighthouse pass: fonts and image sizes', 'done', 'high', 1, 5],
  ['API', 'Sandbox environment with seeded test keys', 'done', 'high', 2, 5],
  ['MOB', 'Onboarding carousel copy review', 'done', 'low', 0, 1],
  ['WEB', 'Case study template for customer stories', 'done', 'medium', 4, 3],
  ['API', 'SDK quickstart for TypeScript', 'done', 'medium', 5, 3],

  ['WEB', 'Docs search with keyboard shortcut', 'review', 'high', 1, 5],
  ['MOB', 'In-app review prompt after third success', 'review', 'medium', 3, 2],
  ['API', 'Scoped API keys with read-only option', 'review', 'urgent', 2, 5],
  ['WEB', 'Cookie consent banner and preferences', 'review', 'high', 5, 3],
  ['WEB', 'Changelog page fed from release notes', 'doing', 'medium', 5, 3],
  ['WEB', 'Interactive pricing calculator', 'doing', 'high', 1, 5],
  ['MOB', 'Widget for today’s tasks on the home screen', 'doing', 'high', 3, 8],
  ['MOB', 'Settings screen rebuild with sections', 'doing', 'medium', 4, 3],
  ['API', 'Usage metering events to billing', 'doing', 'urgent', 2, 8],
  ['API', 'Webhook retries with exponential backoff', 'doing', 'high', 5, 5],
  ['WEB', 'Localized landing pages for zh-CN and en', 'doing', 'medium', 4, 5],
  ['WEB', 'Footer sitemap and legal links', 'todo', 'low', 5, 1],
  ['WEB', '404 page with search and popular links', 'todo', 'low', 4, 2],
  ['WEB', 'Status page link in header', 'todo', 'medium', 1, 1],
  ['MOB', 'Share sheet for exporting a project summary', 'todo', 'medium', 3, 3],
  ['MOB', 'Accessibility labels on custom controls', 'todo', 'high', 4, 3],
  ['MOB', 'Release checklist for 2.0 store submission', 'todo', 'urgent', 0, 2],
  ['API', 'Deprecation headers for v0 endpoints', 'todo', 'medium', 5, 2],
  ['API', 'Bulk import endpoint for tasks', 'todo', 'high', 2, 8],
  ['API', 'Audit log export as CSV', 'todo', 'medium', null, 3],
  ['WEB', 'Testimonials section A/B test', 'todo', 'low', null, 2],
  ['WEB', 'Migrate blog images to the CDN', 'backlog', 'low', null, 3],
  ['WEB', 'Interactive product tour', 'backlog', 'medium', null, 8],
  ['WEB', 'Partner directory page', 'backlog', 'low', null, null],
  ['MOB', 'Tablet layout for project overview', 'backlog', 'medium', null, 8],
  ['MOB', 'Haptics on drag and drop', 'backlog', 'low', null, 1],
  ['MOB', 'Apple Watch quick capture', 'backlog', 'low', null, null],
  ['API', 'GraphQL gateway spike', 'backlog', 'low', null, 5],
  ['API', 'Per-region data residency', 'backlog', 'high', null, 13],
  ['API', 'Python SDK', 'backlog', 'medium', null, 8],
  ['MOB', 'Calendar sync for due dates', 'backlog', 'medium', null, 5],
]
// How many tasks finished in each of the last eight weeks, oldest first: a team finding its pace.
const doneByWeek = [2, 3, 3, 4, 3, 5, 4, 4]
// Open tasks with deadlines, in days from today (negative: overdue). Index-aligned with open plans.
const openDue = [-3, 2, -1, 5, 4, 9, 1, -6, 3, -2, 6, 12, 8, 14, -4, 1, null, 10, 21, null, 18, null, null, 28, null, null, null, null, null, null, null]
const comments: Record<string, [number, string][]> = {
  'Rate limiter middleware with per-key buckets': [
    [0, 'Let’s start with a token bucket per key and a global ceiling per IP.'],
    [2, 'Bench shows 0.3 ms overhead per request at p99. Good enough?'],
    [0, 'Ship it. Document the 429 body in the error guide.'],
  ],
  'Offline queue for drafts created without signal': [
    [3, 'Using the outbox pattern: drafts get a client id so retries stay idempotent.'],
    [0, 'Please make sure the queue survives an app update.'],
  ],
  'Docs search with keyboard shortcut': [
    [1, 'Ready for review. ⌘K opens it, arrow keys move, Enter follows.'],
    [4, 'Highlight colour is a bit faint on the dark theme, otherwise lovely.'],
  ],
  'Scoped API keys with read-only option': [
    [2, 'Keys now carry a scope list; middleware rejects writes for read-only keys.'],
    [5, 'Can we show the scope in the dashboard list as well?'],
  ],
  'Usage metering events to billing': [
    [0, 'Finance needs the first invoice run on the 1st. This is the blocker.'],
    [2, 'Events are batched every minute; working on replay after outages.'],
  ],
  'Widget for today’s tasks on the home screen': [[3, 'Android version done. iOS needs a timeline provider, halfway there.']],
  'Interactive pricing calculator': [
    [0, 'Sales asked for annual vs monthly toggle on the calculator too.'],
    [1, 'Added. Numbers come from the same plan table as the pricing page.'],
  ],
  'Release checklist for 2.0 store submission': [[0, 'Screenshots in all three sizes are still missing.']],
  'Webhook retries with exponential backoff': [[5, 'Capping at 8 attempts over 24h, then the endpoint is marked failing.']],
  'Localized landing pages for zh-CN and en': [[4, 'Chinese copy is in; waiting on final hero illustration.']],
  'Cookie consent banner and preferences': [[5, 'Banner respects Do Not Track; preferences are stored for 6 months.']],
  'Image upload with resumable chunks': [
    [3, '5 MB chunks with a resume token; tested on a flaky 3G profile.'],
    [0, 'Great work, this was the top support complaint.'],
  ],
  'OpenAPI spec generated from route schemas': [[2, 'Spec is now built in CI and diffed against the published one.']],
  'Accessibility labels on custom controls': [[4, 'VoiceOver reads the swipe actions as “button”. Needs proper labels.']],
  'Bulk import endpoint for tasks': [[2, 'Thinking 1,000 rows per request, validated up front, all-or-nothing.']],
}

/**
 * Eight weeks of a small product team. The seed writes history that already happened, so it sets
 * the columns the triggers own itself (number, position, completion time and events), with the
 * triggers disabled inside the install transaction. The api tests check the result is exactly
 * what the triggers would have written.
 */
export async function seedProjects(c: pg.PoolClient, schema: string, today = new Date()) {
  const insert = async (table: string, row: Record<string, unknown>) => {
    const entries = Object.entries(row)
    await c.query(
      `INSERT INTO ${qi(schema)}.${qi(table)} (${entries.map(([key]) => qi(key)).join(',')}) VALUES (${entries.map((_, i) => '$' + (i + 1)).join(',')})`,
      entries.map(([, value]) => value),
    )
  }
  const rand = random(20261103)
  const now = today.getTime()
  const DAY = 86_400_000
  // Working hours in China (UTC+8), so the timeline reads like a real team's.
  const workTime = (daysAgo: number) => {
    const d = new Date(now - daysAgo * DAY)
    d.setUTCHours(1 + Math.floor(rand() * 9), Math.floor(rand() * 60), Math.floor(rand() * 60), 0)
    return Math.min(d.getTime(), now - 60_000)
  }
  const dayOfMs = (ms: number) => iso(ms).slice(0, 10)

  const members = [
    ['Lin Mei', 'Product lead', '#e5484d'],
    ['Arjun Patel', 'Frontend engineer', '#5e5ce6'],
    ['Sofia Rossi', 'Backend engineer', '#12a594'],
    ['Chen Hao', 'Mobile engineer', '#f76b15'],
    ['Grace Ong', 'Product designer', '#d6409f'],
    ['Noah Kim', 'Full-stack engineer', '#0090ff'],
  ].map(([name, role, color], i) => ({ id: randomUUID(), created_at: iso(now - 70 * DAY + i * 1000), name, role, color }))
  for (const m of members) await insert('members', m)
  const projects = {
    WEB: { id: randomUUID(), name: 'Website relaunch', key: 'WEB', color: '#5e5ce6', description: 'New marketing site, docs search and pricing for the autumn launch.' },
    MOB: { id: randomUUID(), name: 'Mobile app 2.0', key: 'MOB', color: '#f76b15', description: 'Offline-first rewrite of the iOS and Android apps, shipping before the holidays.' },
    API: { id: randomUUID(), name: 'Public API', key: 'API', color: '#12a594', description: 'Stable v1 of the REST API, SDKs and developer docs.' },
  }
  for (const [i, p] of Object.values(projects).entries())
    await insert('projects', { ...p, archived: false, created_at: iso(now - 64 * DAY + i * 1000) })

  type Seeded = {
    id: string
    plan: Plan
    created: number
    events: { kind: string; from: string | null; to: string | null; at: number }[]
    completed: number | null
    due: string | null
    assignee: string | null
  }
  const seeded: Seeded[] = []
  let doneIndex = 0
  let openIndex = 0
  for (const plan of plans) {
    const [, title, status, , assigneeIndex] = plan
    const assignee = assigneeIndex === null ? null : members[assigneeIndex].id
    // Where the task's life ends: its completion, or a recent day for work still open.
    let end: number
    let completed: number | null = null
    let due: string | null
    if (status === 'done') {
      let week = 0
      for (let n = doneIndex++; n >= doneByWeek[week]; week++) n -= doneByWeek[week]
      // Week 7 is the current week: never later than today.
      const weeksAgo = doneByWeek.length - 1 - week
      const weekday = Math.floor(rand() * (weeksAgo === 0 ? Math.max(1, (today.getUTCDay() + 6) % 7 + 1) : 5))
      const monday = now - ((today.getUTCDay() + 6) % 7) * DAY - weeksAgo * 7 * DAY
      end = completed = workTime((now - monday) / DAY - weekday)
      due = rand() < 0.75 ? dayOfMs(completed + Math.round(rand() * 6 - 2) * DAY) : null
    } else {
      end = workTime(rand() * 3)
      const offset = openDue[openIndex++]
      due = offset === null || offset === undefined ? null : dayOfMs(now + offset * DAY)
    }
    const span = status === 'backlog' ? 10 + rand() * 45 : 4 + rand() * 18
    const created = Math.min(end - DAY / 2, workTime((now - end) / DAY + span))
    // The path through the board. Planned work starts in backlog; some of it bounces back
    // from review, the way real reviews do.
    const path: Status[] = []
    const startInBacklog = status === 'backlog' || rand() < 0.55
    for (const s of statuses) {
      if (s === 'backlog' && !startInBacklog) continue
      path.push(s)
      if (s === status) break
    }
    if (statuses.indexOf(status) >= statuses.indexOf('done') && rand() < 0.3) path.splice(path.indexOf('review') + 1, 0, 'doing', 'review')
    const events: Seeded['events'] = [{ kind: 'created', from: null, to: path[0], at: created }]
    const steps = path.length - 1
    let previous = created
    for (let i = 1; i <= steps; i++) {
      const target = created + ((end - created) * i) / steps
      const at = i === steps ? end : Math.max(previous + 60_000, target - rand() * (target - previous) * 0.4)
      events.push({ kind: 'status', from: path[i - 1], to: path[i], at })
      previous = at
      // Assigned when the work is picked up: backlog items have no owner until then.
      if (assignee && startInBacklog && path[i - 1] === 'backlog')
        events.push({ kind: 'assignee', from: null, to: assignee, at: at + 1000 })
    }
    // A few finished tasks changed hands mid-way, so the history shows more than one kind of change.
    if (assignee && status === 'done' && title.length % 4 === 0) {
      const other = members[(assigneeIndex! + 1) % members.length].id
      const moves = events.filter((e) => e.kind === 'status')
      const started = moves.findIndex((e) => e.to === 'doing')
      const first = events.find((e) => e.kind === 'assignee')
      if (first) first.to = other
      events.push({ kind: 'assignee', from: other, to: assignee, at: (moves[started].at + moves[started + 1].at) / 2 })
    }
    events.sort((a, b) => a.at - b.at)
    seeded.push({ id: randomUUID(), plan, created, events, completed, due, assignee })
  }

  // Numbered in creation order within each project, then placed in each column by priority.
  const ordered = [...seeded].sort((a, b) => a.created - b.created)
  const numbers = new Map<string, number>()
  const counters = new Map<string, number>()
  for (const t of ordered) {
    const next = (counters.get(t.plan[0]) ?? 0) + 1
    counters.set(t.plan[0], next)
    numbers.set(t.id, next)
  }
  const positions = new Map<string, number>()
  for (const key of Object.keys(projects))
    for (const s of statuses) {
      const cells = seeded
        .filter((t) => t.plan[0] === key && t.plan[2] === s)
        .sort((a, b) =>
          s === 'done'
            ? b.completed! - a.completed!
            : priorities.indexOf(a.plan[3]) - priorities.indexOf(b.plan[3]) || numbers.get(a.id)! - numbers.get(b.id)!,
        )
      cells.forEach((t, i) => positions.set(t.id, (i + 1) * POSITION_STEP))
    }

  const tasks = `${qi(schema)}.${qi('tasks')}`
  await c.query(`ALTER TABLE ${tasks} DISABLE TRIGGER USER`)
  for (const t of ordered) {
    const [key, title, status, priority, , points] = t.plan
    await insert('tasks', {
      id: t.id,
      created_at: iso(t.created),
      project_id: projects[key].id,
      number: numbers.get(t.id),
      title,
      description: descriptions[title] ?? '',
      status,
      priority,
      assignee_id: t.assignee,
      points,
      due_on: t.due,
      position: positions.get(t.id),
      completed_at: t.completed === null ? null : iso(t.completed),
    })
    for (const e of t.events)
      await insert('task_events', { task_id: t.id, kind: e.kind, from_value: e.from, to_value: e.to, at: iso(e.at), created_at: iso(e.at) })
    const notes = comments[title] ?? []
    const last = t.events[t.events.length - 1].at
    for (const [i, [author, body]] of notes.entries()) {
      // Spread across the task's life, after it was created and no later than now.
      const at = Math.min(now - 60_000, t.created + ((Math.max(last, t.created + DAY) - t.created) * (i + 1)) / (notes.length + 1))
      await insert('comments', { task_id: t.id, author_id: members[author].id, body, created_at: iso(at) })
    }
  }
  await c.query(`ALTER TABLE ${tasks} ENABLE TRIGGER USER`)
}

const descriptions: Record<string, string> = {
  'Docs search with keyboard shortcut':
    'Search across guides and API reference from any docs page.\n\n- ⌘K / Ctrl+K opens the palette\n- Results grouped by section\n- Works without JavaScript as a plain search page',
  'Interactive pricing calculator':
    'Let visitors estimate their monthly bill from seats and usage. Must use the same plan table as the pricing page so the numbers never drift.',
  'Usage metering events to billing':
    'Emit one usage event per billable request, batched per minute, so invoices can be generated from the meter instead of the request log.',
  'Scoped API keys with read-only option': 'Keys get a list of scopes. Read-only keys can call GET endpoints only; anything else returns 403 with code key_scope.',
  'Widget for today’s tasks on the home screen': 'Small and medium widget sizes. Tapping a task opens it in the app.',
  'Release checklist for 2.0 store submission':
    'Screenshots, privacy labels, release notes in English and Chinese, phased rollout plan, and a rollback owner.',
  'Rate limiter middleware with per-key buckets': '100 requests per second per key with bursts of 200. Return Retry-After on 429.',
  'Offline queue for drafts created without signal': 'Drafts created offline are queued and sent in order once the device reconnects.',
  'Per-region data residency': 'Customers in the EU and APAC want their data pinned to a region. Needs a design doc before estimating properly.',
  'Bulk import endpoint for tasks': 'Accept CSV or JSON, validate everything before writing, and report row-level errors.',
  'Cookie consent banner and preferences': 'Only load analytics after consent. Preferences reachable from the footer.',
}
