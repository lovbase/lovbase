import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import type { IR, Field } from '@lovbase/core/ir'
import { irToDDL, qi } from '@lovbase/core/ddl'
import { openStages, stageProbability, stages, type ActivityKind, type Stage } from '@lovbase/core/crm'

type Definition = [string, string, Array<[string, Field['type'], string?]>]
const definitions: Definition[] = [
  [
    'companies',
    '公司',
    [
      ['name', 'text'],
      ['industry', 'text'],
      ['website', 'text'],
      ['city', 'text'],
    ],
  ],
  [
    'contacts',
    '联系人',
    [
      ['company_id', 'link', 'companies'],
      ['name', 'text'],
      ['title', 'text'],
      ['email', 'text'],
      ['phone', 'text'],
    ],
  ],
  [
    'deals',
    '商机',
    [
      ['company_id', 'link', 'companies'],
      ['contact_id', 'link', 'contacts'],
      ['title', 'text'],
      ['stage', 'select', stages.join(',')],
      ['amount_cents', 'number'],
      ['probability', 'number'],
      ['expected_close', 'text'],
      ['owner', 'text'],
      ['closed_on', 'text'],
      ['lost_reason', 'text'],
    ],
  ],
  [
    'activities',
    '跟进记录',
    [
      ['deal_id', 'link', 'deals'],
      ['kind', 'select', 'call,email,meeting,note,task'],
      ['body', 'text'],
      ['due_on', 'text'],
      ['done', 'boolean'],
    ],
  ],
  [
    'deal_stage_history',
    '阶段变更',
    [
      ['deal_id', 'link', 'deals'],
      ['from_stage', 'select', stages.join(',')],
      ['to_stage', 'select', stages.join(',')],
      ['changed_at', 'date'],
    ],
  ],
]
export const crmIR: IR = {
  version: 1,
  appName: 'Sales Pipeline',
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
const day = (column: string) => `CHECK(${column} IS NULL OR (${column} ~ '^\\d{4}-\\d{2}-\\d{2}$' AND ${column}::date IS NOT NULL))`
const today = `to_char(current_date, 'YYYY-MM-DD')`

/**
 * The pipeline rules live in the database, so the app's single-statement writes, an app the owner
 * later rewrites and a query typed into the SQL console all get the same bookkeeping: stage
 * history, close dates and won/lost probabilities are never the client's job.
 */
export async function installCrm(c: pg.PoolClient, schema: string) {
  await c.query(irToDDL(crmIR, schema))
  const s = qi(schema)
  const table = (name: string) => `${s}.${qi(name)}`
  await c.query(`ALTER TABLE ${table('companies')}
    ALTER COLUMN name SET NOT NULL, ADD CHECK(btrim(name) <> '' AND length(name) <= 160),
    ALTER COLUMN industry SET NOT NULL, ALTER COLUMN industry SET DEFAULT '',
    ALTER COLUMN website SET NOT NULL, ALTER COLUMN website SET DEFAULT '',
    ALTER COLUMN city SET NOT NULL, ALTER COLUMN city SET DEFAULT ''`)
  await c.query(`ALTER TABLE ${table('contacts')}
    ALTER COLUMN company_id SET NOT NULL,
    ALTER COLUMN name SET NOT NULL, ADD CHECK(btrim(name) <> '' AND length(name) <= 160),
    ALTER COLUMN title SET NOT NULL, ALTER COLUMN title SET DEFAULT '',
    ALTER COLUMN email SET NOT NULL, ALTER COLUMN email SET DEFAULT '',
    ADD CHECK(email = '' OR email ~ '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$'),
    ALTER COLUMN phone SET NOT NULL, ALTER COLUMN phone SET DEFAULT ''`)
  await c.query(`ALTER TABLE ${table('deals')}
    ALTER COLUMN company_id SET NOT NULL,
    ALTER COLUMN title SET NOT NULL, ADD CHECK(btrim(title) <> '' AND length(title) <= 200),
    ALTER COLUMN stage SET NOT NULL, ALTER COLUMN stage SET DEFAULT 'lead', ADD CHECK(stage IN (${list(stages)})),
    ALTER COLUMN amount_cents SET NOT NULL, ALTER COLUMN amount_cents SET DEFAULT 0,
    ADD CHECK(amount_cents = trunc(amount_cents) AND amount_cents >= 0 AND amount_cents <= 1000000000000),
    ALTER COLUMN probability SET NOT NULL,
    ADD CHECK(probability = trunc(probability) AND probability BETWEEN 0 AND 100),
    ADD CHECK(stage <> 'won' OR probability = 100), ADD CHECK(stage <> 'lost' OR probability = 0),
    ADD ${day('expected_close')}, ADD ${day('closed_on')},
    ADD CHECK((stage IN ('won','lost')) = (closed_on IS NOT NULL)),
    ADD CHECK(stage = 'lost' OR lost_reason IS NULL),
    ALTER COLUMN owner SET NOT NULL, ALTER COLUMN owner SET DEFAULT ''`)
  await c.query(`ALTER TABLE ${table('activities')}
    ALTER COLUMN deal_id SET NOT NULL,
    ALTER COLUMN kind SET NOT NULL, ADD CHECK(kind IN ('call','email','meeting','note','task')),
    ALTER COLUMN body SET NOT NULL, ALTER COLUMN body SET DEFAULT '', ADD CHECK(length(body) <= 4000),
    ADD ${day('due_on')}, ADD CHECK(kind = 'task' OR due_on IS NULL),
    ALTER COLUMN done SET NOT NULL, ALTER COLUMN done SET DEFAULT false`)
  await c.query(`ALTER TABLE ${table('deal_stage_history')}
    ALTER COLUMN deal_id SET NOT NULL,
    ALTER COLUMN to_stage SET NOT NULL, ADD CHECK(to_stage IN (${list(stages)})),
    ADD CHECK(from_stage IS NULL OR from_stage IN (${list(stages)})),
    ALTER COLUMN changed_at SET NOT NULL, ALTER COLUMN changed_at SET DEFAULT now()`)
  // A deal's activities and history go with it; a contact who leaves just drops off the deal.
  await c.query(`ALTER TABLE ${table('activities')} DROP CONSTRAINT activities_deal_id_fkey,
    ADD FOREIGN KEY (deal_id) REFERENCES ${table('deals')}(id) ON DELETE CASCADE`)
  await c.query(`ALTER TABLE ${table('deal_stage_history')} DROP CONSTRAINT deal_stage_history_deal_id_fkey,
    ADD FOREIGN KEY (deal_id) REFERENCES ${table('deals')}(id) ON DELETE CASCADE`)
  await c.query(`ALTER TABLE ${table('deals')} DROP CONSTRAINT deals_contact_id_fkey,
    ADD FOREIGN KEY (contact_id) REFERENCES ${table('contacts')}(id) ON DELETE SET NULL`)
  await c.query(`CREATE INDEX ON ${table('contacts')}(company_id)`)
  await c.query(`CREATE INDEX ON ${table('deals')}(company_id)`)
  await c.query(`CREATE INDEX ON ${table('deals')}(stage)`)
  await c.query(`CREATE INDEX ON ${table('activities')}(deal_id)`)
  await c.query(`CREATE INDEX ON ${table('deal_stage_history')}(deal_id, changed_at)`)

  // Before a deal is written: won and lost pin the probability and stamp the close date, reopening
  // clears it, entering an open stage resets the probability unless the same write set one, and the
  // contact has to work at the deal's company.
  const defaults = openStages.map((stage) => `WHEN '${stage}' THEN ${stageProbability[stage]}`).join(' ')
  await c.query(`CREATE FUNCTION ${s}.crm_deal_rules() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE moved boolean := true;
    BEGIN
      -- Separate statements: OLD does not exist on INSERT.
      IF TG_OP = 'UPDATE' THEN moved := NEW.stage IS DISTINCT FROM OLD.stage; END IF;
      IF NEW.stage = 'won' THEN NEW.probability := 100;
      ELSIF NEW.stage = 'lost' THEN NEW.probability := 0;
      ELSIF NEW.probability IS NULL THEN NEW.probability := CASE NEW.stage ${defaults} END;
      ELSIF moved AND TG_OP = 'UPDATE' THEN
        IF NEW.probability = OLD.probability THEN NEW.probability := CASE NEW.stage ${defaults} END; END IF;
      END IF;
      IF NEW.stage NOT IN ('won','lost') THEN NEW.closed_on := NULL;
      ELSIF TG_OP = 'INSERT' THEN NEW.closed_on := coalesce(NEW.closed_on, ${today});
      ELSIF moved AND NEW.closed_on IS NOT DISTINCT FROM OLD.closed_on THEN NEW.closed_on := ${today};
      END IF;
      IF NEW.stage <> 'lost' THEN NEW.lost_reason := NULL; END IF;
      IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ${table('contacts')} WHERE id = NEW.contact_id AND company_id = NEW.company_id
      ) THEN
        RAISE EXCEPTION 'crm_contact_company' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$`)
  await c.query(`CREATE TRIGGER deal_rules BEFORE INSERT OR UPDATE ON ${table('deals')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.crm_deal_rules()`)
  // After a deal is created or changes stage: one history row, written by the database alone.
  await c.query(`CREATE FUNCTION ${s}.crm_stage_history() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO ${table('deal_stage_history')}(deal_id, from_stage, to_stage) VALUES (NEW.id, NULL, NEW.stage);
      ELSIF NEW.stage IS DISTINCT FROM OLD.stage THEN
        INSERT INTO ${table('deal_stage_history')}(deal_id, from_stage, to_stage) VALUES (NEW.id, OLD.stage, NEW.stage);
      END IF;
      RETURN NULL;
    END $$`)
  await c.query(`CREATE TRIGGER stage_created AFTER INSERT ON ${table('deals')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.crm_stage_history()`)
  await c.query(`CREATE TRIGGER stage_changed AFTER UPDATE OF stage ON ${table('deals')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.crm_stage_history()`)
  // History is append-only and has a single author: a row may only be inserted by the trigger
  // above (nested, so depth > 1) and only removed by the cascade when its deal is deleted.
  await c.query(`CREATE FUNCTION ${s}.crm_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' OR pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'crm_history_is_automatic' USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      NEW.changed_at := now();
      RETURN NEW;
    END $$`)
  await c.query(`CREATE TRIGGER history_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table('deal_stage_history')}
    FOR EACH ROW EXECUTE FUNCTION ${s}.crm_history_guard()`)
}

/** Deterministic, so every demo and every copy starts from the same believable five months. */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

type Language = 'zh' | 'en'
// [name, industry, city, domain, language]. Fictional throughout.
const companies: [string, string, string, string, Language][] = [
  ['青禾食品', 'food', '深圳', 'qinghe', 'zh'],
  ['Northgate Freight', 'logistics', 'Hong Kong', 'northgate', 'en'],
  ['星河教育', 'education', '广州', 'xinghe', 'zh'],
  ['Harbourline Clinics', 'healthcare', 'Hong Kong', 'harbourline', 'en'],
  ['远山建筑设计', 'design', '上海', 'yuanshan', 'zh'],
  ['Bluefin Analytics', 'software', 'Singapore', 'bluefin', 'en'],
  ['小满咖啡', 'food', '杭州', 'xiaoman', 'zh'],
  ['Kestrel Robotics', 'manufacturing', 'Shenzhen', 'kestrel', 'en'],
  ['海岸线旅行', 'travel', '厦门', 'haianxian', 'zh'],
  ['Maple & Finch Studio', 'design', 'London', 'maplefinch', 'en'],
  ['云栖软件', 'software', '杭州', 'yunqi', 'zh'],
  ['Tidewater Retail', 'retail', 'Sydney', 'tidewater', 'en'],
]
// [company, name, title, mailbox]
const contacts: [number, string, string, string][] = [
  [0, '王蕾', '采购经理', 'wanglei'],
  [0, '赵一鸣', '信息部主管', 'zhaoyiming'],
  [1, 'Grace Leung', 'Head of Operations', 'grace.leung'],
  [1, 'Tom Whitaker', 'IT Director', 'tom.whitaker'],
  [1, 'Daniel Ho', 'Procurement Lead', 'daniel.ho'],
  [2, '刘倩', '教务副校长', 'liuqian'],
  [2, '孙浩然', '技术负责人', 'sunhaoran'],
  [3, 'Dr. Hannah Lau', 'Medical Director', 'hannah.lau'],
  [3, 'Marcus Chan', 'Practice Manager', 'marcus.chan'],
  [4, '周敏', '合伙人', 'zhoumin'],
  [4, '吴昊', '项目总监', 'wuhao'],
  [5, 'Elena Petrova', 'VP Engineering', 'elena.petrova'],
  [5, 'Sam Okafor', 'Finance Manager', 'sam.okafor'],
  [6, '林小满', '创始人', 'linxiaoman'],
  [6, '何嘉', '运营经理', 'hejia'],
  [7, 'Ivy Zhang', 'Plant Manager', 'ivy.zhang'],
  [7, 'Ben Carter', 'CTO', 'ben.carter'],
  [8, '郑涛', '总经理', 'zhengtao'],
  [8, '许静', '客服总监', 'xujing'],
  [9, 'Olivia Finch', 'Managing Director', 'olivia.finch'],
  [9, 'Noah Patel', 'Studio Manager', 'noah.patel'],
  [10, '陈默', '架构师', 'chenmo'],
  [10, '黄丽', '采购专员', 'huangli'],
  [11, 'Chloe Martin', 'Head of Stores', 'chloe.martin'],
  [11, 'Jack Wilson', 'CIO', 'jack.wilson'],
]
const owners = ['陈思远', 'Alex Morgan', '李悦', 'Priya Nair'] as const
/**
 * [company, title, amount in yuan, owner, final stage, created days ago, closed days ago,
 * furthest open stage reached (lost deals), lost reason]. Wins land in each of the last five
 * months, so the dashboard has a story to tell on any day the demo is opened.
 */
type SeedDeal = [number, string, number, number, Stage, number, number?, Stage?, string?]
const deals: SeedDeal[] = [
  [0, '门店订货系统', 180_000, 0, 'won', 125, 84],
  [0, '冷链追踪试点', 64_000, 2, 'proposal', 40],
  [1, 'Fleet telematics rollout', 420_000, 1, 'negotiation', 70],
  [1, 'Warehouse scanning add-on', 85_000, 1, 'won', 120, 62],
  [1, 'Customs paperwork automation', 150_000, 3, 'lost', 135, 88, 'proposal', 'competitor'],
  [2, '线上课程平台', 240_000, 2, 'won', 110, 40],
  [2, '教师排课工具', 56_000, 2, 'qualified', 22],
  [3, 'Patient booking portal', 310_000, 3, 'proposal', 55],
  [3, 'Clinic analytics pilot', 48_000, 3, 'won', 80, 21],
  [4, '项目协同工作台', 132_000, 0, 'negotiation', 60],
  [4, '图纸归档迁移', 38_000, 0, 'lost', 100, 70, 'qualified', 'no_budget'],
  [5, 'Data platform licence', 560_000, 1, 'negotiation', 90],
  [5, 'Support plan renewal', 72_000, 1, 'won', 50, 12],
  [6, '会员小程序', 45_000, 2, 'won', 75, 33],
  [6, '门店 POS 对接', 28_000, 2, 'lead', 6],
  [7, 'Assembly line dashboards', 260_000, 3, 'proposal', 35],
  [7, 'Spare parts portal', 90_000, 3, 'lost', 95, 45, 'negotiation', 'price'],
  [8, '行程管理系统', 175_000, 0, 'qualified', 28],
  [8, '旺季客服外包', 60_000, 0, 'lost', 60, 18, 'lead', 'timing'],
  [9, 'Studio project tracker', 42_000, 1, 'won', 130, 100],
  [9, 'Client portal', 68_000, 1, 'lead', 9],
  [10, '私有化部署', 380_000, 2, 'proposal', 48],
  [10, '安全审计服务', 95_000, 0, 'won', 100, 55],
  [11, 'Inventory sync for 40 stores', 290_000, 3, 'qualified', 30],
  [11, 'Loyalty programme revamp', 150_000, 3, 'won', 170, 140],
  [0, '供应商对账', 52_000, 0, 'lead', 3],
  [2, '家长沟通 App', 88_000, 2, 'lost', 70, 30, 'proposal', 'no_decision'],
  [3, 'Telehealth integration', 205_000, 3, 'lead', 12],
  [5, 'Embedded BI module', 140_000, 1, 'qualified', 18],
  [7, 'Quality inspection pilot', 120_000, 1, 'won', 60, 6],
  [10, '数据中台咨询', 160_000, 0, 'negotiation', 45],
  [11, 'Store staffing app', 76_000, 3, 'lead', 15],
  [1, 'Driver app localisation', 54_000, 1, 'qualified', 25],
  [4, '材料库存管理', 66_000, 0, 'lost', 40, 8, 'negotiation', 'competitor'],
  [9, 'Brand asset library', 36_000, 1, 'won', 35, 2],
]
/** Days from today until an open deal is expected to close, by stage. One negotiation is overdue. */
const expectIn: Record<string, number[]> = {
  lead: [75, 62, 90, 58, 84],
  qualified: [48, 41, 55, 60, 37],
  proposal: [26, 33, 19, 38],
  negotiation: [9, -3, 14, 21],
}
const words = {
  zh: {
    created: ['来自官网咨询，初步了解需求。', '老客户转介绍，约了首次沟通。', '展会上交换了名片，对方有明确预算。'],
    call: ['电话沟通了预算和上线时间。', '和对方技术负责人过了一遍集成方案。'],
    meeting: ['到访演示，对方 IT 负责人参加。', '方案评审会，确认了试点范围。'],
    email: ['发送了报价单和实施计划。', '补充了安全与数据合规说明。'],
    won: '合同已签回，安排实施启动会。',
    lost: '对方决定暂缓，保持季度回访。',
    tasks: ['准备修订版报价', '跟进合同条款', '安排试点启动会', '发送客户案例', '确认决策流程'],
  },
  en: {
    created: ['Inbound from the website, early discovery.', 'Referral from an existing customer, intro call booked.', 'Met at the trade show; they have budget this year.'],
    call: ['Call on budget and rollout timing.', 'Walked their tech lead through the integration plan.'],
    meeting: ['On-site demo with their IT lead.', 'Solution review; pilot scope agreed.'],
    email: ['Sent the quote and implementation plan.', 'Followed up with the security and data-handling notes.'],
    won: 'Signed contract received; kickoff being scheduled.',
    lost: 'They are pausing for now; check back next quarter.',
    tasks: ['Send revised quote', 'Follow up on contract terms', 'Book pilot kickoff', 'Share a customer case study', 'Confirm the sign-off process'],
  },
}

export async function seedCrm(c: pg.PoolClient, schema: string, now = new Date()) {
  const insert = async (table: string, row: Record<string, unknown>) => {
    const entries = Object.entries(row)
    await c.query(
      `INSERT INTO ${qi(schema)}.${qi(table)} (${entries.map(([key]) => qi(key)).join(',')}) VALUES (${entries.map((_, i) => '$' + (i + 1)).join(',')})`,
      entries.map(([, value]) => value),
    )
  }
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  /** A moment `days` days ago at `hours` UTC (office hours in China), never later than now. */
  const at = (days: number, hours = 2) => new Date(Math.min(now.getTime() - 60_000, midnight - days * 86_400_000 + hours * 3_600_000))
  const dayOf = (days: number) => new Date(midnight - days * 86_400_000).toISOString().slice(0, 10)
  const rand = random(20261103)
  const pick = <T>(values: readonly T[]) => values[Math.floor(rand() * values.length)]
  // The seed writes five months of history with their real dates, which the triggers would stamp
  // as today. They are switched off for this transaction only; the rows below satisfy every CHECK
  // and the consistency the triggers would have produced, which the API tests verify.
  await c.query(`ALTER TABLE ${qi(schema)}.deals DISABLE TRIGGER USER`)
  await c.query(`ALTER TABLE ${qi(schema)}.deal_stage_history DISABLE TRIGGER USER`)

  const companyIds: string[] = []
  for (const [index, [name, industry, city, domain]] of companies.entries()) {
    const id = randomUUID()
    companyIds.push(id)
    await insert('companies', { id, created_at: at(180, 1 + index * 0.1), name, industry, website: `https://${domain}.example`, city })
  }
  const contactIds = new Map<number, string[]>()
  for (const [index, [company, name, title, mailbox]] of contacts.entries()) {
    const id = randomUUID()
    contactIds.set(company, [...(contactIds.get(company) ?? []), id])
    const phone = companies[company][2] === 'Hong Kong' ? `+852 5550 ${String(1000 + index * 37).slice(-4)}` : `+86 139 0000 ${String(2000 + index * 53).slice(-4)}`
    await insert('contacts', { id, created_at: at(178, 1 + index * 0.1), company_id: companyIds[company], name, title, email: `${mailbox}@${companies[company][3]}.example.invalid`, phone })
  }

  const expectCursor: Record<string, number> = {}
  for (const [index, [company, title, yuan, owner, stage, created, closed, reached, lostReason]] of deals.entries()) {
    const id = randomUUID()
    const language = companies[company][4]
    const text = words[language]
    const people = contactIds.get(company) ?? []
    const open = closed === undefined
    // The stages walked through, oldest first: every open stage up to where it stands or stopped.
    const last = stage === 'won' ? 'negotiation' : stage === 'lost' ? reached! : stage
    const path: Stage[] = [...openStages.slice(0, openStages.indexOf(last) + 1), ...(open ? [] : [stage])]
    const end = open ? Math.max(1, Math.round(created * 0.3)) : closed
    const moments = path.map((_, i) => at(created - ((created - end) * i) / Math.max(1, path.length - 1), 1.5 + (index % 6) + ((index * 13) % 60) / 60))
    let expected: string
    if (open) {
      const offsets = expectIn[stage]
      const n = expectCursor[stage] ?? 0
      expectCursor[stage] = n + 1
      expected = dayOf(-offsets[n % offsets.length])
    } else expected = dayOf(closed + (index % 3) * 4 - 4)
    await insert('deals', {
      id,
      created_at: moments[0],
      company_id: companyIds[company],
      contact_id: people[index % people.length] ?? null,
      title,
      stage,
      amount_cents: yuan * 100,
      // A couple of reps override the stage default, the way real forecasts drift.
      probability: index === 2 ? 70 : index === 11 ? 60 : stageProbability[stage],
      expected_close: expected,
      owner: owners[owner],
      closed_on: open ? null : dayOf(closed),
      lost_reason: stage === 'lost' ? lostReason : null,
    })
    for (const [i, to] of path.entries())
      await insert('deal_stage_history', { id: randomUUID(), created_at: moments[i], deal_id: id, from_stage: i ? path[i - 1] : null, to_stage: to, changed_at: moments[i] })

    const activity = async (when: Date, kind: ActivityKind, body: string, due: string | null = null, done = false) =>
      insert('activities', { id: randomUUID(), created_at: when, deal_id: id, kind, body, due_on: due, done })
    const later = (moment: Date, hours: number) => new Date(Math.min(now.getTime() - 60_000, moment.getTime() + hours * 3_600_000))
    await activity(later(moments[0], 0.5), 'note', pick(text.created))
    const kinds: ActivityKind[] = ['call', 'meeting', 'email']
    for (let i = 1; i < path.length; i++) {
      if (path[i] === 'won') await activity(later(moments[i], 1), 'note', text.won)
      else if (path[i] === 'lost') await activity(later(moments[i], 1), 'note', text.lost)
      else {
        const kind = kinds[(index + i) % kinds.length]
        await activity(later(moments[i], -22), kind, pick(text[kind as 'call' | 'meeting' | 'email']))
      }
    }
    // Follow-ups: open deals mostly have one coming up (a few slipped past due); won deals show
    // the task that closed them out, done.
    if (open && index % 4 !== 3) {
      const due = index % 6 === 1 ? 2 : -((index % 9) + 1)
      await activity(later(moments[moments.length - 1], 2), 'task', text.tasks[index % text.tasks.length], dayOf(due))
    } else if (stage === 'won')
      await activity(later(moments[moments.length - 2], 3), 'task', text.tasks[(index + 2) % text.tasks.length], dayOf(closed! + 2), true)
  }
  await c.query(`ALTER TABLE ${qi(schema)}.deals ENABLE TRIGGER USER`)
  await c.query(`ALTER TABLE ${qi(schema)}.deal_stage_history ENABLE TRIGGER USER`)
}
