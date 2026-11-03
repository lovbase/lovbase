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
    engine: 'sql' as const,
  },
] as const

export function templateById(id: string) {
  return templates.find((template) => template.id === id)
}

export type TemplateId = (typeof templates)[number]['id']
