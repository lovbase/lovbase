export type TemplateLocale = 'zh' | 'en'
export type Localized = Record<TemplateLocale, string>

export const templates = [
  {
    id: 'inkwave',
    version: 1,
    name: { zh: 'INKWAVE 墨浪对战', en: 'INKWAVE · Turf War' },
    description: {
      zh: '在浏览器中涂墨争地，打造属于你的 3D 对战游戏。',
      en: 'Paint the arena and make this 3D browser game your own.',
    },
    categoryId: 'games',
    category: { zh: '游戏与互动', en: 'Games & Interactive' },
    cover: '/templates/inkwave.jpg',
    /** Replaced by a community-published version; the page and remixes still work for old links. */
    unlisted: true,
    highlights: {
      zh: ['浏览器里的 3D 涂墨对战：5v5 对局，空位由机器人补齐', '整套源码可改：场景、队伍、规则都在你手里', '想要排行榜或玩家档案，加几张表就行'],
      en: ['A 3D turf-war game in the browser: 5v5 matches, with bots filling the empty seats', 'Ships as source you can reskin: the arena, the teams, the rules', 'Want a leaderboard or player profiles? Add a table or two'],
    },
  },
  {
    id: 'inventory',
    version: 1,
    name: { zh: '库存与采购管理', en: 'Inventory & Purchasing' },
    description: {
      zh: '从入库到采购，让每一件库存都有迹可循。',
      en: 'Every item accounted for. From receiving to replenishment.',
    },
    categoryId: 'operations',
    category: { zh: '运营管理', en: 'Operations' },
    cover: '/templates/inventory.jpg',
    highlights: {
      zh: ['总览、可搜索的商品、供应商目录与层级库位', '入库、出库、调整与调拨，每一笔流水不可篡改', '采购单支持分批收货，带补货建议与 CSV 导入'],
      en: ['Dashboard, searchable products, a supplier directory and a location hierarchy', 'Receive, ship, adjust and transfer stock with an immutable movement history', 'Purchase orders with partial receipts, replenishment suggestions and CSV import'],
    },
  },
  {
    id: 'product-3d',
    version: 1,
    name: { zh: '三维商品配置与报价', en: '3D Product Studio' },
    description: {
      zh: '从一把椅子的灵感，到一份真实的报价。',
      en: 'From a considered chair to a quote that means business.',
    },
    categoryId: 'commerce',
    category: { zh: '商品与销售', en: 'Commerce' },
    cover: '/templates/product-3d.svg',
    highlights: {
      zh: ['在三维视图里搭配面料与支架，实时出报价', '保存命名方案，记录客户询价并跟进状态', '商品、材质与价格都能在界面里改，不用碰代码'],
      en: ['Configure upholstery colors and frame finishes in 3D, with a live quote', 'Save named designs and record customer inquiries with a status', 'Edit the product, its finishes and its prices without touching code'],
    },
  },
  {
    id: 'ledger',
    version: 1,
    name: { zh: '记账与预算', en: 'Ledger & Budgets' },
    description: {
      zh: '复式记账、多币种账户与月度预算，每一分钱都对得上。',
      en: 'Double-entry books, multi-currency accounts and monthly budgets that always balance.',
    },
    categoryId: 'finance',
    category: { zh: '财务', en: 'Finance' },
    cover: '/templates/ledger.svg',
    highlights: {
      zh: ['支出、收入与转账，支持多币种账户', '期初余额、冲销而非修改、月度预算与报表', '账目平衡由数据库保证：凭证只增不改，借贷必平'],
      en: ['Expense, income and transfer entries across multi-currency accounts', 'Opening balances, reversing entries instead of edits, monthly budgets and reports', 'The database keeps the books balanced: entries are append-only and every posting nets to zero'],
    },
  },
  {
    id: 'crm',
    version: 1,
    name: { zh: '客户与销售管道', en: 'Sales Pipeline CRM' },
    description: {
      zh: '从线索到签约，每一笔商机的去向与预测都一目了然。',
      en: 'From first lead to signed deal. A pipeline you can forecast from.',
    },
    categoryId: 'customers',
    category: { zh: '客户与服务', en: 'Customers & Service' },
    cover: '/templates/crm.svg',
    highlights: {
      zh: ['销售管道看板，按阶段汇总与加权金额，拖拽推进商机', '客户、联系人、跟进时间线与待办集中在一处', '阶段历史、结束日期与赢单概率由数据库触发器维护'],
      en: ['A pipeline board with stage totals and weighted value; drag deals between stages', 'Companies, contacts, an activity timeline and follow-up tasks in one place', 'Stage history, close dates and win probability are kept by database triggers'],
    },
    engine: 'sql' as const,
  },
  {
    id: 'projects',
    version: 1,
    name: { zh: '项目与任务看板', en: 'Project Board' },
    description: {
      zh: '看板、清单与个人待办，任务编号与动态由数据库记录，进度一目了然。',
      en: 'Boards, lists and personal queues, with numbering and history kept by the database.',
    },
    categoryId: 'teamwork',
    category: { zh: '团队协作', en: 'Teamwork' },
    cover: '/templates/projects.svg',
    highlights: {
      zh: ['每个项目一个看板，拖拽排序，清单可筛选，还有个人待办', '任务抽屉里有评论、估点、截止日期与完整动态', '任务编号与动态由数据库分配，并发创建也不会重号'],
      en: ['A board per project with drag-and-drop columns, a filterable list and a personal queue', 'Task drawers with comments, points, due dates and a full activity history', 'Task numbers and history are assigned by the database, so concurrent edits never collide'],
    },
    engine: 'sql' as const,
  },
  {
    id: 'booking',
    version: 1,
    name: { zh: '预约与排班', en: 'Bookings & Scheduling' },
    description: {
      zh: '服务项目、人员与房间排班，同一时段绝不重复预约。',
      en: 'Services, staff and rooms on one calendar, and never a double booking.',
    },
    categoryId: 'customers',
    category: { zh: '客户与服务', en: 'Customers & Service' },
    cover: '/templates/booking.svg',
    highlights: {
      zh: ['按人员或房间的日程、周视图与可处理状态的预约列表', '客户到访记录、服务项目、营业时间与经营概览', '绝不重复预约：数据库对资源加锁，重叠的写入直接拒绝'],
      en: ['A day schedule per person or room, a week view and a bookings list with status handling', 'Customer visit records, services and opening hours, plus an overview of the business', 'No double bookings, ever: the database locks the resource and rejects the overlap'],
    },
    engine: 'sql' as const,
  },
  {
    id: 'recruiting',
    version: 1,
    engine: 'sql' as const,
    name: { zh: '招聘管理', en: 'Recruiting Pipeline' },
    description: {
      zh: '从职位发布到录用，每位候选人走到哪一步都一目了然。',
      en: 'From open role to signed offer, every candidate in plain sight.',
    },
    categoryId: 'teamwork',
    category: { zh: '团队协作', en: 'Teamwork' },
    cover: '/templates/recruiting.svg',
    highlights: {
      zh: ['职位带各阶段人数与名额，每个职位一个拖拽流程看板', '候选人档案、面试评分、漏斗与渠道报表', '招聘规则由数据库执行：一人一投、名额锁定、满额自动关闭'],
      en: ['Open roles with per-stage counts and seats, and a drag-and-drop pipeline per job', 'Candidate profiles, interview scorecards, funnel and source reports', 'Hiring rules live in the database: one application per job, seats enforced, roles close when filled'],
    },
  },
  {
    id: 'helpdesk',
    version: 1,
    name: { zh: '客服工单', en: 'Helpdesk' },
    description: {
      zh: '收件箱、SLA 倒计时与客户全貌，每张工单都有人跟进、按时回复。',
      en: 'A shared inbox with SLA clocks and the whole customer in view. No ticket left waiting.',
    },
    categoryId: 'customers',
    category: { zh: '客户与服务', en: 'Customers & Service' },
    cover: '/templates/helpdesk.svg',
    highlights: {
      zh: ['全部、未分配、我的、紧急、逾期、已解决等收件箱视图，按 SLA 截止排序', '客户档案里能看到全部工单与对话', '工单生命周期由数据库驱动：SLA 截止、首响与解决时间由触发器维护'],
      en: ['Inbox views for open, unassigned, mine, urgent, overdue and solved, sorted by the next SLA deadline', 'Customer profiles with every ticket and conversation in view', 'The database runs the ticket lifecycle: SLA deadlines, first-response and resolution times come from triggers'],
    },
    engine: 'sql' as const,
  },
] as const

export function templateById(id: string) {
  return templates.find((template) => template.id === id)
}

/** What the gallery, the landing page and the sitemap show. */
export const listedTemplates = templates.filter((template) => !('unlisted' in template && template.unlisted))

export type TemplateId = (typeof templates)[number]['id']
export type Template = (typeof templates)[number]
