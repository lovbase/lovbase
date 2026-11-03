import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import type { IR, Field } from '@lovbase/core/ir'
import { irToDDL, qi } from '@lovbase/core/ddl'
import {
  dayOf,
  employments,
  interviewKinds,
  jobStatuses,
  pipeline,
  recommendations,
  sources,
  stages,
  type Employment,
  type InterviewKind,
  type Recommendation,
  type Source,
  type Stage,
} from '@lovbase/core/recruiting'

type Definition = [string, string, Array<[string, Field['type'], string?]>]
const list = (values: readonly string[]) => values.join(',')
const definitions: Definition[] = [
  [
    'jobs',
    '职位',
    [
      ['title', 'text'],
      ['title_en', 'text'],
      ['department', 'text'],
      ['location', 'text'],
      ['employment', 'select', list(employments)],
      ['status', 'select', list(jobStatuses)],
      ['headcount', 'number'],
      ['opened_on', 'text'],
    ],
  ],
  [
    'candidates',
    '候选人',
    [
      ['name', 'text'],
      ['email', 'text'],
      ['phone', 'text'],
      ['source', 'select', list(sources)],
      ['current_title', 'text'],
      ['notes', 'text'],
    ],
  ],
  [
    'applications',
    '应聘',
    [
      ['job_id', 'link', 'jobs'],
      ['candidate_id', 'link', 'candidates'],
      ['stage', 'select', list(stages)],
      ['rating', 'number'],
      ['rejected_reason', 'text'],
      ['applied_on', 'text'],
      ['stage_changed_at', 'date'],
    ],
  ],
  [
    'interviews',
    '面试',
    [
      ['application_id', 'link', 'applications'],
      ['kind', 'select', list(interviewKinds)],
      ['scheduled_at', 'date'],
      ['interviewer', 'text'],
      ['score', 'number'],
      ['recommendation', 'select', list(recommendations)],
      ['feedback', 'text'],
    ],
  ],
  [
    'stage_events',
    '阶段记录',
    [
      ['application_id', 'link', 'applications'],
      ['from_stage', 'select', list(stages)],
      ['to_stage', 'select', list(stages)],
      ['at', 'date'],
    ],
  ],
]
export const recruitingIR: IR = {
  version: 1,
  appName: 'Recruiting',
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

const within = (column: string, values: readonly string[]) => `${column} IN (${values.map((v) => `'${v}'`).join(',')})`
const among = (column: string, values: readonly string[]) => `CHECK(${within(column, values)})`
const day = (column: string) => `CHECK(${column} IS NULL OR (${column} ~ '^\\d{4}-\\d{2}-\\d{2}$' AND ${column}::date IS NOT NULL))`
const whole = (column: string, low: number, high: number) =>
  `CHECK(${column} IS NULL OR (${column} = trunc(${column}) AND ${column} BETWEEN ${low} AND ${high}))`

/**
 * The hiring rules live in the database, so the app, an app the owner's agent rewrites and a
 * statement typed into the SQL console all meet the same ones:
 * - a candidate applies to a job once, and only while it is open;
 * - every stage change is stamped and written to stage_events, which nothing else may write;
 * - a hire locks its job row and fails if the seats are taken, so two recruiters hiring for the
 *   last seat at the same moment cannot both succeed; the hire that fills the last seat closes
 *   the job; a hire is final.
 */
export async function installRecruiting(c: pg.PoolClient, schema: string) {
  await c.query(irToDDL(recruitingIR, schema))
  const s = qi(schema)
  const table = (name: string) => `${s}.${qi(name)}`
  await c.query(`ALTER TABLE ${table('jobs')}
    ALTER COLUMN title SET NOT NULL, ALTER COLUMN title_en SET NOT NULL, ALTER COLUMN title_en SET DEFAULT '',
    ALTER COLUMN department SET NOT NULL, ALTER COLUMN location SET NOT NULL,
    ALTER COLUMN employment SET NOT NULL, ALTER COLUMN employment SET DEFAULT 'full_time',
    ALTER COLUMN status SET NOT NULL, ALTER COLUMN status SET DEFAULT 'draft',
    ALTER COLUMN headcount SET NOT NULL, ALTER COLUMN headcount SET DEFAULT 1,
    ADD CHECK(length(btrim(title)) BETWEEN 1 AND 120),
    ADD ${among('employment', employments)}, ADD ${among('status', jobStatuses)},
    ADD CHECK(headcount = trunc(headcount) AND headcount BETWEEN 1 AND 500),
    ADD ${day('opened_on')}, ADD CHECK(status = 'draft' OR opened_on IS NOT NULL)`)
  await c.query(`ALTER TABLE ${table('candidates')}
    ALTER COLUMN name SET NOT NULL, ALTER COLUMN email SET NOT NULL,
    ALTER COLUMN phone SET NOT NULL, ALTER COLUMN phone SET DEFAULT '',
    ALTER COLUMN source SET NOT NULL, ALTER COLUMN source SET DEFAULT 'other',
    ALTER COLUMN current_title SET NOT NULL, ALTER COLUMN current_title SET DEFAULT '',
    ALTER COLUMN notes SET NOT NULL, ALTER COLUMN notes SET DEFAULT '',
    ADD CHECK(length(btrim(name)) BETWEEN 1 AND 120),
    ADD CHECK(email ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'),
    ADD ${among('source', sources)}`)
  await c.query(`CREATE UNIQUE INDEX candidates_email ON ${table('candidates')} (lower(email))`)
  // A person's applications, interviews and history leave with them when they ask to be removed.
  await c.query(`ALTER TABLE ${table('applications')}
    DROP CONSTRAINT applications_candidate_id_fkey,
    ADD CONSTRAINT applications_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES ${table('candidates')}(id) ON DELETE CASCADE,
    ALTER COLUMN job_id SET NOT NULL, ALTER COLUMN candidate_id SET NOT NULL,
    ALTER COLUMN stage SET NOT NULL, ALTER COLUMN stage SET DEFAULT 'applied',
    ALTER COLUMN applied_on SET NOT NULL, ALTER COLUMN applied_on SET DEFAULT to_char(current_date, 'YYYY-MM-DD'),
    ALTER COLUMN stage_changed_at SET NOT NULL, ALTER COLUMN stage_changed_at SET DEFAULT now(),
    ADD ${among('stage', stages)}, ADD ${whole('rating', 1, 5)}, ADD ${day('applied_on')},
    ADD CHECK(stage <> 'rejected' OR length(btrim(rejected_reason)) BETWEEN 1 AND 500),
    ADD CONSTRAINT applications_once UNIQUE(job_id, candidate_id)`)
  await c.query(`ALTER TABLE ${table('interviews')}
    DROP CONSTRAINT interviews_application_id_fkey,
    ADD CONSTRAINT interviews_application_id_fkey FOREIGN KEY (application_id) REFERENCES ${table('applications')}(id) ON DELETE CASCADE,
    ALTER COLUMN application_id SET NOT NULL, ALTER COLUMN kind SET NOT NULL, ALTER COLUMN scheduled_at SET NOT NULL,
    ALTER COLUMN interviewer SET NOT NULL, ALTER COLUMN feedback SET NOT NULL, ALTER COLUMN feedback SET DEFAULT '',
    ADD ${among('kind', interviewKinds)}, ADD ${whole('score', 1, 4)},
    ADD CHECK(recommendation IS NULL OR ${within('recommendation', recommendations)}),
    ADD CHECK((score IS NULL) = (recommendation IS NULL))`)
  await c.query(`ALTER TABLE ${table('stage_events')}
    DROP CONSTRAINT stage_events_application_id_fkey,
    ADD CONSTRAINT stage_events_application_id_fkey FOREIGN KEY (application_id) REFERENCES ${table('applications')}(id) ON DELETE CASCADE,
    ALTER COLUMN application_id SET NOT NULL, ALTER COLUMN to_stage SET NOT NULL,
    ALTER COLUMN at SET NOT NULL, ALTER COLUMN at SET DEFAULT now(),
    ADD CHECK(from_stage IS NULL OR ${within('from_stage', stages)}), ADD ${among('to_stage', stages)}`)
  await c.query(`CREATE INDEX ON ${table('applications')}(job_id, stage)`)
  await c.query(`CREATE INDEX ON ${table('applications')}(candidate_id)`)
  await c.query(`CREATE INDEX ON ${table('interviews')}(application_id)`)
  await c.query(`CREATE INDEX ON ${table('stage_events')}(application_id, at)`)

  // Jobs: a job gets its opening day when it first leaves draft; seats cannot drop below the
  // people already hired; a filled job reopens only with more seats.
  await c.query(`CREATE FUNCTION ${s}.recruiting_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE hired integer; total integer;
    BEGIN
      IF NEW.status <> 'draft' AND NEW.opened_on IS NULL THEN
        NEW.opened_on := to_char(current_date, 'YYYY-MM-DD');
      END IF;
      IF TG_OP = 'UPDATE' THEN
        SELECT count(*) FILTER (WHERE stage = 'hired'), count(*) INTO hired, total
          FROM ${table('applications')} WHERE job_id = NEW.id;
        IF NEW.headcount < hired THEN
          RAISE EXCEPTION 'headcount_below_hired' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.status = 'draft' AND total > 0 THEN
          RAISE EXCEPTION 'job_has_applications' USING ERRCODE = 'check_violation';
        END IF;
        IF OLD.status = 'closed' AND NEW.status <> 'closed' AND hired >= NEW.headcount THEN
          RAISE EXCEPTION 'headcount_filled' USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $$`)
  await c.query(`CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON ${table('jobs')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.recruiting_job_guard()`)

  // Applications: the stamp, the open-job rule and the headcount, decided while holding the job row.
  await c.query(`CREATE FUNCTION ${s}.recruiting_application_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE job record; hired integer; at timestamptz;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.job_id <> OLD.job_id OR NEW.candidate_id <> OLD.candidate_id OR NEW.applied_on <> OLD.applied_on THEN
          RAISE EXCEPTION 'application_locked' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.stage = OLD.stage THEN
          -- Rating or reason edits: the stage clock keeps running from the last real change.
          NEW.stage_changed_at := OLD.stage_changed_at;
          RETURN NEW;
        END IF;
        IF OLD.stage = 'hired' THEN
          RAISE EXCEPTION 'hired_is_final' USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      -- Now, unless the statement records a move that already happened: then it must lie in the
      -- past and after the previous change, so the history always reads in order.
      IF TG_OP = 'INSERT' THEN at := coalesce(NEW.stage_changed_at, now());
      ELSIF NEW.stage_changed_at IS DISTINCT FROM OLD.stage_changed_at THEN at := NEW.stage_changed_at;
      ELSE at := now();
      END IF;
      IF at IS NULL OR at > now() OR (TG_OP = 'UPDATE' AND at < OLD.stage_changed_at) THEN
        RAISE EXCEPTION 'invalid_stage_time' USING ERRCODE = 'check_violation';
      END IF;
      NEW.stage_changed_at := at;
      IF NEW.stage <> 'rejected' THEN NEW.rejected_reason := NULL; END IF;

      IF NEW.stage = 'hired' THEN
        -- Two hires for the same job queue here; the second counts after the first commits.
        SELECT status, headcount INTO job FROM ${table('jobs')} WHERE id = NEW.job_id FOR UPDATE;
        SELECT count(*) INTO hired FROM ${table('applications')}
          WHERE job_id = NEW.job_id AND stage = 'hired' AND id <> NEW.id;
        IF hired >= job.headcount THEN
          RAISE EXCEPTION 'headcount_filled' USING ERRCODE = 'check_violation';
        END IF;
        IF job.status = 'closed' OR (TG_OP = 'INSERT' AND job.status <> 'open') THEN
          RAISE EXCEPTION 'job_closed' USING ERRCODE = 'check_violation';
        END IF;
        IF hired + 1 = job.headcount THEN
          UPDATE ${table('jobs')} SET status = 'closed' WHERE id = NEW.job_id;
        END IF;
      ELSIF TG_OP = 'INSERT' THEN
        SELECT status INTO job FROM ${table('jobs')} WHERE id = NEW.job_id FOR SHARE;
        IF job.status IS DISTINCT FROM 'open' THEN
          RAISE EXCEPTION 'job_not_open' USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $$`)
  await c.query(`CREATE TRIGGER guard BEFORE INSERT OR UPDATE ON ${table('applications')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.recruiting_application_guard()`)

  await c.query(`CREATE FUNCTION ${s}.recruiting_log_stage() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO ${table('stage_events')}(application_id, from_stage, to_stage, at)
        VALUES (NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.stage END, NEW.stage, NEW.stage_changed_at);
      RETURN NULL;
    END $$`)
  await c.query(`CREATE TRIGGER log_stage AFTER INSERT ON ${table('applications')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.recruiting_log_stage()`)
  await c.query(`CREATE TRIGGER log_stage_change AFTER UPDATE OF stage ON ${table('applications')}
    FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage) EXECUTE FUNCTION ${s}.recruiting_log_stage()`)

  // The history is the database's own: only a trigger (the log above, or the cascade when a
  // candidate is removed) may touch it, never a statement sent from outside.
  await c.query(`CREATE FUNCTION ${s}.recruiting_events_managed() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'stage_events_managed' USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$`)
  await c.query(`CREATE TRIGGER managed BEFORE INSERT OR UPDATE OR DELETE ON ${table('stage_events')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.recruiting_events_managed()`)
}

/** Deterministic, so every demo and every copy starts from the same believable quarter. */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

type Final = Stage | `rejected@${'applied' | 'screening' | 'interview' | 'offer'}` | 'filled'
type JobPlan = {
  title: string
  title_en: string
  department: string
  location: string
  employment: Employment
  headcount: number
  openedDaysAgo: number | null
  status: 'draft' | 'open' | 'paused' | 'closed'
  team: string[]
  roles: string[]
  finals: Partial<Record<Final, number>>
}
// What each job's applications end up as. The filled job's hires close it through the trigger.
const jobPlans: JobPlan[] = [
  {
    title: '高级后端工程师', title_en: 'Senior Backend Engineer', department: 'Engineering', location: 'London',
    employment: 'full_time', headcount: 2, openedDaysAgo: 82, status: 'open',
    team: ['Daniel Ho', 'Jonas Weber', 'Priya Nair'], roles: ['Backend Engineer', 'Backend Developer', 'Software Engineer', 'Platform Engineer', 'Java Developer'],
    finals: { hired: 1, offer: 1, interview: 3, screening: 3, applied: 4, 'rejected@applied': 4, 'rejected@screening': 3, 'rejected@interview': 3, 'rejected@offer': 1 },
  },
  {
    title: '产品设计师', title_en: 'Product Designer', department: 'Design', location: 'Amsterdam',
    employment: 'full_time', headcount: 1, openedDaysAgo: 64, status: 'open',
    team: ['Maya Lin', 'Clara Fischer'], roles: ['UI/UX Designer', 'Interaction Designer', 'Visual Designer', 'Product Designer'],
    finals: { offer: 1, interview: 2, screening: 2, applied: 3, 'rejected@applied': 3, 'rejected@screening': 2, 'rejected@interview': 2 },
  },
  {
    title: '数据分析师', title_en: 'Data Analyst', department: 'Data', location: 'Remote',
    employment: 'full_time', headcount: 1, openedDaysAgo: 47, status: 'open',
    team: ['Priya Nair', 'Ivy Lam'], roles: ['Business Analyst', 'Data Analyst', 'BI Developer', 'Data Scientist'],
    finals: { interview: 3, screening: 2, applied: 3, 'rejected@applied': 2, 'rejected@screening': 2, 'rejected@interview': 1 },
  },
  {
    title: '客户成功经理', title_en: 'Customer Success Manager', department: 'Customer Success', location: 'Singapore',
    employment: 'full_time', headcount: 2, openedDaysAgo: 90, status: 'open',
    team: ['Ivy Lam', 'Maya Lin'], roles: ['Account Manager', 'Client Manager', 'Customer Success Lead', 'Key Account Manager'],
    finals: { hired: 2, filled: 3, 'rejected@applied': 3, 'rejected@screening': 3, 'rejected@interview': 2, 'rejected@offer': 1 },
  },
  {
    title: '前端开发实习生', title_en: 'Frontend Engineering Intern', department: 'Engineering', location: 'Berlin',
    employment: 'intern', headcount: 3, openedDaysAgo: 36, status: 'open',
    team: ['Jonas Weber', 'Daniel Ho'], roles: ['Computer Science student', 'Computer Science undergraduate', 'Frontend intern', 'Software Engineering student'],
    finals: { hired: 1, offer: 1, interview: 2, screening: 3, applied: 3, 'rejected@applied': 2, 'rejected@screening': 2, 'rejected@interview': 1 },
  },
  {
    title: '内容营销（合同）', title_en: 'Content Marketer (Contract)', department: 'Marketing', location: 'Remote',
    employment: 'contract', headcount: 1, openedDaysAgo: 55, status: 'paused',
    team: ['Clara Fischer', 'Maya Lin'], roles: ['Content Writer', 'Social Media Manager', 'Copywriter', 'Marketing Specialist'],
    finals: { interview: 1, screening: 2, applied: 2, 'rejected@applied': 2, 'rejected@screening': 1 },
  },
  {
    title: '财务运营负责人', title_en: 'Finance Operations Lead', department: 'Finance', location: 'London',
    employment: 'full_time', headcount: 1, openedDaysAgo: null, status: 'draft',
    team: [], roles: [], finals: {},
  },
]

// Fictional people. Emails use the reserved .invalid domain; phones the reserved 555-01xx range.
const people: [string, string][] = [
  ['Wei Zhang', 'wei.zhang'], ['Emily Carter', 'emily.carter'], ['Mei Lin', 'mei.lin'], ['Marcus Bell', 'marcus.bell'],
  ['Mateo Alvarez', 'mateo.alvarez'], ['Sofia Ramos', 'sofia.ramos'], ['Anya Volkov', 'anya.volkov'], ['Arjun Mehta', 'arjun.mehta'],
  ['Kwame Mensah', 'kwame.mensah'], ['Hannah Weber', 'hannah.weber'], ['Sienna Walsh', 'sienna.walsh'], ['Leo Tanaka', 'leo.tanaka'],
  ['Rafael Duarte', 'rafael.duarte'], ['Chloe Martin', 'chloe.martin'], ['Jun Park', 'jun.park'], ['Noah Kim', 'noah.kim'],
  ['Ingrid Berg', 'ingrid.berg'], ['Grace Okafor', 'grace.okafor'], ['Omar Farouk', 'omar.farouk'], ['Lucas Silva', 'lucas.silva'],
  ['Camille Dubois', 'camille.dubois'], ['Isabel Moreau', 'isabel.moreau'], ['Liam Doyle', 'liam.doyle'], ['Ethan Wright', 'ethan.wright'],
  ['Hana Sato', 'hana.sato'], ['Aisha Rahman', 'aisha.rahman'], ['Diego Herrera', 'diego.herrera'], ['Oliver Grant', 'oliver.grant'],
  ['Nora Lindgren', 'nora.lindgren'], ['Mei Tan', 'mei.tan'], ['Kai Nakamura', 'kai.nakamura'], ['Daniel Novak', 'daniel.novak'],
  ['Amara Diallo', 'amara.diallo'], ['Ryan Chua', 'ryan.chua'], ['Theo Jansen', 'theo.jansen'], ['Amelia Hughes', 'amelia.hughes'],
  ['Leila Karimi', 'leila.karimi'], ['Kenji Mori', 'kenji.mori'], ['Andre Santos', 'andre.santos'], ['Zoe Fischer', 'zoe.fischer'],
  ['Mia Kowalski', 'mia.kowalski'], ['Victor Lindqvist', 'victor.lindqvist'], ['Ravi Shah', 'ravi.shah'], ['Nadia Petrova', 'nadia.petrova'],
  ['Sara Eriksson', 'sara.eriksson'], ['Samuel Osei', 'samuel.osei'], ['Jin Lee', 'jin.lee'], ['Julia Costa', 'julia.costa'],
  ['Alice Nguyen', 'alice.nguyen'], ['Ben Archer', 'ben.archer'], ['Pablo Fernandez', 'pablo.fernandez'], ['Lina Haddad', 'lina.haddad'],
  ['Fatima Zahra', 'fatima.zahra'], ['Tomás Ruiz', 'tomas.ruiz'], ['Sebastian Koch', 'sebastian.koch'], ['Freya Olsen', 'freya.olsen'],
  ['Ana Pereira', 'ana.pereira'], ['Hugo Laurent', 'hugo.laurent'], ['Dev Patel', 'dev.patel'], ['Priya Iyer', 'priya.iyer'],
  ['Lily Huang', 'lily.huang'], ['Jack Turner', 'jack.turner'], ['Eva Novotna', 'eva.novotna'], ['Yara Nasser', 'yara.nasser'],
  ['Tariq Hassan', 'tariq.hassan'], ['Elena Rossi', 'elena.rossi'], ['Niko Virtanen', 'niko.virtanen'], ['Felix Braun', 'felix.braun'],
  ['Chiara Bianchi', 'chiara.bianchi'], ['Ivy Chen', 'ivy.chen'],
]

// Typical days in each stage before the next step, as [shortest, longest].
const stint: Record<'applied' | 'screening' | 'interview' | 'offer', [number, number]> = {
  applied: [1, 5],
  screening: [3, 9],
  interview: [6, 15],
  offer: [2, 7],
}
const reasonsAt: Record<string, string[]> = {
  applied: ['experience', 'location', 'skills', 'experience'],
  screening: ['skills', 'compensation', 'withdrew', 'experience'],
  interview: ['skills', 'experience', 'withdrew', 'Accepted a counter-offer from current employer'],
  offer: ['compensation', 'Asked for more than the approved band'],
}
const praise = ['Clear thinker, explained trade-offs well.', 'Strong fundamentals; would raise the bar on the team.', 'Great ownership stories, very collaborative.', 'Solid. Communicates crisply under pressure.']
const doubts = ['Struggled with the system design prompt.', 'Experience is thinner than the CV suggests.', 'Good energy, but gaps in the core skills.', 'Unclear motivation for the role.']

type Op = { at: number; run: () => Promise<unknown> }

export async function seedRecruiting(c: pg.PoolClient, schema: string, today = new Date()) {
  const insert = async (table: string, row: Record<string, unknown>) => {
    const entries = Object.entries(row)
    await c.query(
      `INSERT INTO ${qi(schema)}.${qi(table)} (${entries.map(([key]) => qi(key)).join(',')}) VALUES (${entries.map((_, i) => '$' + (i + 1)).join(',')})`,
      entries.map(([, value]) => value),
    )
  }
  const rand = random(20261104)
  const between = (low: number, high: number) => low + rand() * (high - low)
  const pick = <T>(values: readonly T[]) => values[Math.floor(rand() * values.length)]
  const now = today.getTime()
  // Nothing is seeded later than two hours ago: the stage trigger refuses moves in the future.
  const latest = now - 2 * HOUR
  // Office hours in UTC+8, where this fictional company sits.
  const officeHours = (t: number, hour = 2 + Math.floor(rand() * 7)) => {
    const d = new Date(t)
    d.setUTCHours(hour, pick([0, 15, 30, 45]), 0, 0)
    return d.getTime()
  }

  const jobs = jobPlans.map((plan, index) => ({
    ...plan,
    id: randomUUID(),
    opened: plan.openedDaysAgo === null ? null : officeHours(now - plan.openedDaysAgo * DAY, 1),
    index,
  }))
  for (const job of jobs)
    await insert('jobs', {
      id: job.id,
      // Staggered by a millisecond so they list in the order written here.
      created_at: new Date(now + job.index).toISOString(),
      title: job.title,
      title_en: job.title_en,
      department: job.department,
      location: job.location,
      employment: job.employment,
      headcount: job.headcount,
      status: job.status === 'draft' ? 'draft' : 'open',
      opened_on: job.opened === null ? null : dayOf(new Date(job.opened)),
    })

  type Plan = { job: (typeof jobs)[number]; final: Final; person: number; id: string; path: { stage: Stage; at: number; reason?: string }[] }
  const plans: Plan[] = []
  for (const job of jobs)
    for (const [final, count] of Object.entries(job.finals) as [Final, number][])
      for (let i = 0; i < count; i++) plans.push({ job, final, person: -1, id: randomUUID(), path: [] })
  // Shuffle, then hand out people: everyone applies once, a few apply to a second job.
  for (let i = plans.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[plans[i], plans[j]] = [plans[j], plans[i]]
  }
  plans.forEach((plan, i) => {
    if (i < people.length) plan.person = i
    else {
      let person = Math.floor(rand() * people.length)
      while (plans.some((p) => p.person === person && p.job === plan.job)) person = (person + 1) % people.length
      plan.person = person
    }
  })

  // Lay each application's path out in time, keeping it inside its job's window and the past.
  const filledAt = new Map<string, number>()
  for (const plan of plans) {
    const [kind, at] = plan.final.split('@') as [string, string | undefined]
    const end: Stage =
      kind === 'filled' ? pick(['screening', 'interview'] as const) : kind === 'rejected' ? (at as Stage) : (kind as Stage)
    const steps = pipeline.slice(0, pipeline.indexOf(end as (typeof pipeline)[number]) + 1) as Stage[]
    const terminal = kind === 'rejected' || kind === 'hired'
    const spans = steps.slice(0, -1).map((s) => between(...stint[s as keyof typeof stint]) * DAY)
    // Terminal paths also spend the last stage before the decision; open ones are still in it.
    const tail = kind === 'rejected' ? between(...stint[end as keyof typeof stint]) * DAY : 0
    const waiting = terminal || kind === 'filled' ? 0 : between(0.4, 1.4) * between(...stint[end as keyof typeof stint]) * DAY
    let total = spans.reduce((a, b) => a + b, 0) + tail
    const opened = plan.job.opened! + 0.3 * DAY
    // The job that fills takes its applications in the first month, and both hires land after
    // that: the trigger closes it on the second hire and turns away anyone applying later.
    const fills = !!plan.job.finals.filled
    const cutoff = fills ? opened + 30 * DAY : latest
    let start =
      fills && kind === 'hired'
        ? Math.min(latest - total, Math.max(opened, cutoff + between(1, 8) * DAY - total))
        : terminal || kind === 'filled'
          ? between(opened, Math.max(opened, Math.min(cutoff, latest - total)))
          : latest - waiting - total
    if (start < opened) {
      const room = Math.max(DAY, latest - waiting - opened)
      const scale = Math.min(1, room / Math.max(total, 1))
      spans.forEach((_, i) => (spans[i] *= scale))
      total *= scale
      start = opened
    }
    let t = officeHours(start)
    plan.path.push({ stage: 'applied', at: t })
    steps.slice(1).forEach((stage, i) => {
      t = Math.min(latest, t + spans[i])
      plan.path.push({ stage, at: t })
    })
    if (kind === 'rejected') plan.path.push({ stage: 'rejected', at: Math.min(latest, t + tail), reason: pick(reasonsAt[end]) })
    if (kind === 'hired') filledAt.set(plan.job.id, Math.max(filledAt.get(plan.job.id) ?? 0, t))
  }
  // The recruiter tells the people still in process once the last seat is taken.
  for (const plan of plans)
    if (plan.final === 'filled') {
      const closed = filledAt.get(plan.job.id)!
      const last = plan.path[plan.path.length - 1].at
      plan.path.push({ stage: 'rejected', at: Math.min(latest, Math.max(closed, last) + between(1, 3) * DAY), reason: 'filled' })
    }

  // Candidates, sourced in a way that makes the channels differ believably.
  const best = new Map<number, Plan>()
  for (const plan of plans) if (!best.has(plan.person)) best.set(plan.person, plan)
  const sourceFor = (final: Final): Source => {
    const weights: Record<Source, number> =
      final === 'hired' || final === 'offer'
        ? { referral: 45, linkedin: 25, agency: 20, website: 10, other: 0 }
        : final === 'rejected@applied'
          ? { referral: 3, linkedin: 32, agency: 5, website: 45, other: 15 }
          : { referral: 15, linkedin: 35, agency: 12, website: 28, other: 10 }
    let roll = rand() * 100
    for (const source of sources) if ((roll -= weights[source]) < 0) return source
    return 'linkedin'
  }
  const candidateIds: string[] = []
  const notes = ['Referred by Daniel Ho.', 'Available from next month.', 'Open to relocating.', 'Three-month notice period.', 'Prefers hybrid work.']
  for (const [index, [name, handle]] of people.entries()) {
    const plan = best.get(index)!
    const id = randomUUID()
    candidateIds.push(id)
    const firstAt = Math.min(...plans.filter((p) => p.person === index).map((p) => p.path[0].at))
    await insert('candidates', {
      id,
      created_at: new Date(firstAt - HOUR).toISOString(),
      name,
      email: `${handle}@example.invalid`,
      phone: index % 4 === 3 ? '' : `+1 202 555 01${String(index).padStart(2, '0')}`,
      source: sourceFor(plan.final),
      current_title: pick(plan.job.roles),
      notes: index % 9 === 4 ? pick(notes) : '',
    })
  }

  // Replay every stage change in time order through the real triggers: they write the history,
  // enforce the seats and close the filled job, exactly as they will for the person using it.
  const ops: Op[] = []
  const table = (name: string) => `${qi(schema)}.${qi(name)}`
  for (const plan of plans) {
    const [first, ...rest] = plan.path
    const furthestIndex = plan.path.filter((p) => p.stage !== 'rejected').length - 1
    const rating = furthestIndex >= 1 ? Math.min(5, Math.max(1, Math.round(between(1.6, 3.2) + furthestIndex * 0.45))) : null
    ops.push({
      at: first.at,
      run: () =>
        insert('applications', {
          id: plan.id,
          created_at: new Date(first.at).toISOString(),
          job_id: plan.job.id,
          candidate_id: candidateIds[plan.person],
          stage: 'applied',
          applied_on: dayOf(new Date(first.at)),
          stage_changed_at: new Date(first.at).toISOString(),
          rating,
        }),
    })
    for (const step of rest)
      ops.push({
        at: step.at,
        run: () =>
          c.query(`UPDATE ${table('applications')} SET stage = $2, rejected_reason = $3, stage_changed_at = $4 WHERE id = $1`, [
            plan.id,
            step.stage,
            step.reason ?? null,
            new Date(step.at).toISOString(),
          ]),
      })
  }
  ops.sort((a, b) => a.at - b.at)
  for (const op of ops) await op.run()
  for (const job of jobs)
    if (job.status === 'paused') await c.query(`UPDATE ${table('jobs')} SET status = 'paused' WHERE id = $1`, [job.id])

  // Interviews: a phone screen during screening, then a loop during the interview stage. Past
  // ones carry scorecards that lean the way the application went; a few still await feedback,
  // and the people interviewing now have their next round on the calendar.
  let awaiting = 0
  for (const plan of plans) {
    const team = plan.job.team
    const outcome = plan.path[plan.path.length - 1].stage
    const reachedOffer = plan.path.some((p) => p.stage === 'offer')
    const positive = outcome === 'hired' || reachedOffer || (outcome !== 'rejected' && rand() < 0.6)
    const book = async (kind: InterviewKind, when: number, from: number, until?: number) => {
      // Office hours can shift a time by most of a day; keep it inside the stage it belongs to.
      const at = until === undefined ? Math.max(from + HOUR, when) : Math.min(until - HOUR, Math.max(from + HOUR, when))
      const interviewer = pick(team)
      const leaving = outcome === 'rejected'
      let scored = at < latest
      // A handful of recent rounds for people still in process are waiting on the interviewer.
      if (scored && !leaving && outcome !== 'hired' && at > now - 5 * DAY && awaiting < 4) {
        scored = false
        awaiting++
      }
      const good = positive || (!leaving && rand() < 0.5)
      const score = good ? pick([3, 3, 4]) : pick([1, 2, 2])
      const recommendation: Recommendation = good ? (score === 4 ? 'strong_yes' : 'yes') : score === 1 ? 'strong_no' : 'no'
      await insert('interviews', {
        id: randomUUID(),
        created_at: new Date(Math.min(latest, from)).toISOString(),
        application_id: plan.id,
        kind,
        scheduled_at: new Date(at).toISOString(),
        interviewer,
        ...(scored
          ? { score, recommendation, feedback: pick(good ? praise : doubts) }
          : {}),
      })
    }
    const entered = (stage: Stage) => plan.path.find((p) => p.stage === stage)?.at
    const left = (stage: Stage) => {
      const i = plan.path.findIndex((p) => p.stage === stage)
      return i >= 0 ? plan.path[i + 1]?.at : undefined
    }
    const screening = entered('screening')
    if (screening && rand() < 0.6) {
      const until = left('screening')
      await book('phone', officeHours(screening + ((until ?? now + 3 * DAY) - screening) * between(0.2, 0.6)), screening, until)
    }
    const interview = entered('interview')
    if (interview) {
      const until = left('interview')
      const rounds: InterviewKind[] = plan.job.employment === 'intern' ? ['technical'] : ['technical', 'onsite', 'culture']
      const finishing = until !== undefined
      const count = finishing ? (outcome === 'rejected' ? 1 + Math.floor(rand() * 2) : rounds.length) : 1 + Math.floor(rand() * 2)
      for (let i = 0; i < Math.min(count, rounds.length); i++) {
        const window = (until ?? latest) - interview
        let at = officeHours(interview + window * ((i + 0.5) / Math.max(count, 1)))
        // The last round of someone still interviewing is coming up in the next week or so.
        if (!finishing && i === count - 1 && i > 0) at = officeHours(now + between(1, 9) * DAY)
        if (!finishing && count === 1 && rand() < 0.5) at = officeHours(now + between(1, 9) * DAY)
        await book(rounds[i], at, interview, until)
      }
    }
  }
}
