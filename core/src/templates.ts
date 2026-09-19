/** Starter templates shown on the home page. Each is a well-formed first prompt plus sample data for the preview. */
export type TemplateTable = { name: string; columns: string[]; rows: string[][]; status?: number }
export type TField = { name: string; dbName: string; type: 'text' | 'number' | 'boolean' | 'date' | 'select' | 'link'; options?: string[]; linkTo?: string }
export type TEntity = { name: string; dbName: string; fields: TField[] }
export type Template = { id: string; name: string; tagline: string; prompt: string; tables: string[]; preview: TemplateTable[]; ir: TEntity[]; seed: Record<string, Record<string, unknown>[]> }

export const TEMPLATES: Template[] = [
  { id: 'crm', name: '销售 CRM', tagline: '客户、联系人、商机、跟进记录', tables: ['客户', '联系人', '商机', '跟进记录'],
    prompt: '做一个销售 CRM:客户(名称、行业、状态)、联系人(属于客户)、商机(金额、阶段、预计成交日期)、跟进记录(时间、方式、摘要,关联客户和联系人)',
    preview: [
      { name: '客户', columns: ['名称', '行业', '状态', '负责人'], status: 2, rows: [['华东纸业', '制造', '跟进中', '王强'], ['南方印刷', '印刷', '已成交', '李梅'], ['北辰物流', '物流', '潜在', '赵云'], ['星河教育', '教育', '跟进中', '王强']] },
      { name: '商机', columns: ['名称', '客户', '金额', '阶段'], status: 3, rows: [['年度纸品采购', '华东纸业', '¥120,000', '方案报价'], ['印刷外包', '南方印刷', '¥48,000', '赢单'], ['仓储合作', '北辰物流', '¥260,000', '需求确认']] },
      { name: '跟进记录', columns: ['时间', '客户', '方式', '摘要'], status: 2, rows: [['09-01', '华东纸业', '拜访', '确认了报价范围'], ['08-30', '北辰物流', '电话', '下周安排现场看仓']] },
    ],
    ir: [
      { name: '客户', dbName: 'customers', fields: [{ name: '名称', dbName: 'name', type: 'text' }, { name: '行业', dbName: 'industry', type: 'text' }, { name: '状态', dbName: 'status', type: 'select', options: ['潜在', '跟进中', '已成交', '流失'] }, { name: '负责人', dbName: 'owner', type: 'text' }] },
      { name: '联系人', dbName: 'contacts', fields: [{ name: '姓名', dbName: 'name', type: 'text' }, { name: '电话', dbName: 'phone', type: 'text' }, { name: '职位', dbName: 'title', type: 'text' }, { name: '客户', dbName: 'customer', type: 'link', linkTo: 'customers' }] },
      { name: '商机', dbName: 'deals', fields: [{ name: '名称', dbName: 'title', type: 'text' }, { name: '金额', dbName: 'amount', type: 'number' }, { name: '阶段', dbName: 'stage', type: 'select', options: ['初步接触', '需求确认', '方案报价', '谈判', '赢单', '输单'] }, { name: '预计成交', dbName: 'expected_close', type: 'date' }, { name: '客户', dbName: 'customer', type: 'link', linkTo: 'customers' }] },
      { name: '跟进记录', dbName: 'followups', fields: [{ name: '时间', dbName: 'happened_at', type: 'date' }, { name: '方式', dbName: 'channel', type: 'select', options: ['电话', '微信', '拜访', '邮件'] }, { name: '摘要', dbName: 'summary', type: 'text' }, { name: '客户', dbName: 'customer', type: 'link', linkTo: 'customers' }] },
    ],
    seed: {
      customers: [{ name: '华东纸业', industry: '制造', status: '跟进中', owner: '王强' }, { name: '南方印刷', industry: '印刷', status: '已成交', owner: '李梅' }, { name: '北辰物流', industry: '物流', status: '潜在', owner: '赵云' }, { name: '星河教育', industry: '教育', status: '跟进中', owner: '王强' }],
      contacts: [{ name: '周敏', phone: '138****0011', title: '采购经理', customer: '华东纸业' }, { name: '陈昊', phone: '139****0022', title: '总经理', customer: '南方印刷' }],
      deals: [{ title: '年度纸品采购', amount: 120000, stage: '方案报价', expected_close: '2026-09-30', customer: '华东纸业' }, { title: '印刷外包', amount: 48000, stage: '赢单', expected_close: '2026-08-20', customer: '南方印刷' }, { title: '仓储合作', amount: 260000, stage: '需求确认', expected_close: '2026-10-15', customer: '北辰物流' }],
      followups: [{ happened_at: '2026-09-01', channel: '拜访', summary: '确认了报价范围', customer: '华东纸业' }, { happened_at: '2026-08-30', channel: '电话', summary: '下周安排现场看仓', customer: '北辰物流' }],
    } },
  { id: 'inventory', name: '库存台账', tagline: '商品、供应商、出入库流水', tables: ['商品', '供应商', '出入库记录'],
    prompt: '做一个库存台账:商品(名称、规格、当前库存、安全库存)、供应商、出入库记录(类型:入库/出库,数量,关联商品和供应商)',
    preview: [
      { name: '商品', columns: ['名称', '规格', '当前库存', '安全库存'], rows: [['A4 复印纸', '70g/500 张', '1,240', '500'], ['碳粉盒', 'TN-2420', '36', '20'], ['文件盒', 'A4 蓝', '210', '100']] },
      { name: '出入库记录', columns: ['日期', '商品', '类型', '数量'], status: 2, rows: [['09-02', 'A4 复印纸', '入库', '500'], ['09-01', '碳粉盒', '出库', '4'], ['08-29', '文件盒', '出库', '30']] },
    ],
    ir: [
      { name: '商品', dbName: 'products', fields: [{ name: '名称', dbName: 'name', type: 'text' }, { name: '规格', dbName: 'spec', type: 'text' }, { name: '当前库存', dbName: 'stock', type: 'number' }, { name: '安全库存', dbName: 'safety_stock', type: 'number' }] },
      { name: '供应商', dbName: 'suppliers', fields: [{ name: '名称', dbName: 'name', type: 'text' }, { name: '联系人', dbName: 'contact', type: 'text' }, { name: '电话', dbName: 'phone', type: 'text' }] },
      { name: '出入库记录', dbName: 'stock_moves', fields: [{ name: '日期', dbName: 'moved_at', type: 'date' }, { name: '类型', dbName: 'kind', type: 'select', options: ['入库', '出库'] }, { name: '数量', dbName: 'qty', type: 'number' }, { name: '商品', dbName: 'product', type: 'link', linkTo: 'products' }, { name: '供应商', dbName: 'supplier', type: 'link', linkTo: 'suppliers' }] },
    ],
    seed: {
      products: [{ name: 'A4 复印纸', spec: '70g/500 张', stock: 1240, safety_stock: 500 }, { name: '碳粉盒', spec: 'TN-2420', stock: 36, safety_stock: 20 }, { name: '文件盒', spec: 'A4 蓝', stock: 210, safety_stock: 100 }],
      suppliers: [{ name: '得力办公', contact: '吴芳', phone: '021-6000****' }, { name: '晨光文具', contact: '刘洋', phone: '021-5000****' }],
      stock_moves: [{ moved_at: '2026-09-02', kind: '入库', qty: 500, product: 'A4 复印纸', supplier: '得力办公' }, { moved_at: '2026-09-01', kind: '出库', qty: 4, product: '碳粉盒' }, { moved_at: '2026-08-29', kind: '出库', qty: 30, product: '文件盒' }],
    } },
  { id: 'events', name: '活动报名', tagline: '活动、报名人、现场签到', tables: ['活动', '报名人'],
    prompt: '做一个活动报名工具:活动(名称、时间、地点、名额)、报名人(姓名、手机号、所属活动、签到状态:未签到/已签到)',
    preview: [
      { name: '活动', columns: ['名称', '时间', '地点', '名额'], rows: [['周五读书会', '09-05 19:00', '三楼会议室', '30'], ['产品发布会', '09-12 14:00', '大礼堂', '200']] },
      { name: '报名人', columns: ['姓名', '手机号', '活动', '签到'], status: 3, rows: [['张三', '138****0001', '周五读书会', '已签到'], ['李四', '139****0002', '周五读书会', '未签到'], ['王五', '137****0003', '产品发布会', '未签到']] },
    ],
    ir: [
      { name: '活动', dbName: 'events', fields: [{ name: '名称', dbName: 'title', type: 'text' }, { name: '时间', dbName: 'starts_at', type: 'date' }, { name: '地点', dbName: 'location', type: 'text' }, { name: '名额', dbName: 'capacity', type: 'number' }] },
      { name: '报名人', dbName: 'attendees', fields: [{ name: '姓名', dbName: 'name', type: 'text' }, { name: '手机号', dbName: 'phone', type: 'text' }, { name: '活动', dbName: 'event', type: 'link', linkTo: 'events' }, { name: '签到状态', dbName: 'checkin', type: 'select', options: ['未签到', '已签到'] }] },
    ],
    seed: {
      events: [{ title: '周五读书会', starts_at: '2026-09-05T19:00:00+08:00', location: '三楼会议室', capacity: 30 }, { title: '产品发布会', starts_at: '2026-09-12T14:00:00+08:00', location: '大礼堂', capacity: 200 }],
      attendees: [{ name: '张三', phone: '138****0001', event: '周五读书会', checkin: '已签到' }, { name: '李四', phone: '139****0002', event: '周五读书会', checkin: '未签到' }, { name: '王五', phone: '137****0003', event: '产品发布会', checkin: '未签到' }],
    } },
  { id: 'tasks', name: '项目任务板', tagline: '项目、任务、负责人、进度', tables: ['项目', '任务', '成员'],
    prompt: '做一个项目任务管理:项目(名称、状态)、成员(姓名、角色)、任务(标题、状态:待办/进行中/完成,优先级,截止日期,关联项目和负责人)',
    preview: [
      { name: '任务', columns: ['标题', '项目', '负责人', '状态', '截止'], status: 3, rows: [['官网改版首页', '官网改版', '小林', '进行中', '09-10'], ['接入支付', 'App 2.0', '小周', '待办', '09-20'], ['压测报告', 'App 2.0', '小陈', '完成', '08-30']] },
      { name: '项目', columns: ['名称', '状态', '成员数'], status: 1, rows: [['官网改版', '进行中', '3'], ['App 2.0', '进行中', '5']] },
    ],
    ir: [
      { name: '项目', dbName: 'projects', fields: [{ name: '名称', dbName: 'name', type: 'text' }, { name: '状态', dbName: 'status', type: 'select', options: ['规划中', '进行中', '已完成'] }] },
      { name: '成员', dbName: 'members', fields: [{ name: '姓名', dbName: 'name', type: 'text' }, { name: '角色', dbName: 'role', type: 'text' }] },
      { name: '任务', dbName: 'tasks', fields: [{ name: '标题', dbName: 'title', type: 'text' }, { name: '状态', dbName: 'status', type: 'select', options: ['待办', '进行中', '完成'] }, { name: '优先级', dbName: 'priority', type: 'select', options: ['高', '中', '低'] }, { name: '截止日期', dbName: 'due', type: 'date' }, { name: '项目', dbName: 'project', type: 'link', linkTo: 'projects' }, { name: '负责人', dbName: 'assignee', type: 'link', linkTo: 'members' }] },
    ],
    seed: {
      projects: [{ name: '官网改版', status: '进行中' }, { name: 'App 2.0', status: '进行中' }],
      members: [{ name: '小林', role: '前端' }, { name: '小周', role: '后端' }, { name: '小陈', role: '测试' }],
      tasks: [{ title: '官网改版首页', status: '进行中', priority: '高', due: '2026-09-10', project: '官网改版', assignee: '小林' }, { title: '接入支付', status: '待办', priority: '高', due: '2026-09-20', project: 'App 2.0', assignee: '小周' }, { title: '压测报告', status: '完成', priority: '中', due: '2026-08-30', project: 'App 2.0', assignee: '小陈' }],
    } },
  { id: 'feedback', name: '客户反馈', tagline: '收集反馈,分类、优先级、处理状态', tables: ['反馈', '客户'],
    prompt: '做一个客户反馈系统:客户(名称、联系方式)、反馈(标题、内容、类型:缺陷/建议/咨询,优先级,处理状态:新建/处理中/已解决,关联客户)',
    preview: [
      { name: '反馈', columns: ['标题', '客户', '类型', '优先级', '状态'], status: 4, rows: [['导出 Excel 乱码', '华东纸业', '缺陷', '高', '处理中'], ['希望支持批量导入', '星河教育', '建议', '中', '新建'], ['发票怎么开', '南方印刷', '咨询', '低', '已解决']] },
    ],
    ir: [
      { name: '客户', dbName: 'customers', fields: [{ name: '名称', dbName: 'name', type: 'text' }, { name: '联系方式', dbName: 'contact', type: 'text' }] },
      { name: '反馈', dbName: 'feedback', fields: [{ name: '标题', dbName: 'title', type: 'text' }, { name: '内容', dbName: 'body', type: 'text' }, { name: '类型', dbName: 'kind', type: 'select', options: ['缺陷', '建议', '咨询'] }, { name: '优先级', dbName: 'priority', type: 'select', options: ['高', '中', '低'] }, { name: '处理状态', dbName: 'status', type: 'select', options: ['新建', '处理中', '已解决'] }, { name: '客户', dbName: 'customer', type: 'link', linkTo: 'customers' }] },
    ],
    seed: {
      customers: [{ name: '华东纸业', contact: 'zhou@example.com' }, { name: '星河教育', contact: '139****0033' }, { name: '南方印刷', contact: 'chen@example.com' }],
      feedback: [{ title: '导出 Excel 乱码', body: '中文列名导出后显示乱码', kind: '缺陷', priority: '高', status: '处理中', customer: '华东纸业' }, { title: '希望支持批量导入', body: '每次手工录入太慢', kind: '建议', priority: '中', status: '新建', customer: '星河教育' }, { title: '发票怎么开', body: '需要增值税专票', kind: '咨询', priority: '低', status: '已解决', customer: '南方印刷' }],
    } },
  { id: 'content', name: '内容日历', tagline: '选题、渠道、发布排期', tables: ['选题', '渠道', '发布计划'],
    prompt: '做一个内容运营日历:渠道(名称、平台)、选题(标题、类型、负责人、状态:想法/写作中/已发布)、发布计划(日期、关联选题和渠道)',
    preview: [
      { name: '发布计划', columns: ['日期', '选题', '渠道', '状态'], status: 3, rows: [['09-03', '新版功能解读', '公众号', '已发布'], ['09-05', '客户案例:华东纸业', '视频号', '写作中'], ['09-08', '行业趋势周报', '小红书', '想法']] },
      { name: '选题', columns: ['标题', '类型', '负责人'], rows: [['新版功能解读', '产品', '小林'], ['客户案例:华东纸业', '案例', '小周']] },
    ],
    ir: [
      { name: '渠道', dbName: 'channels', fields: [{ name: '名称', dbName: 'name', type: 'text' }, { name: '平台', dbName: 'platform', type: 'text' }] },
      { name: '选题', dbName: 'topics', fields: [{ name: '标题', dbName: 'title', type: 'text' }, { name: '类型', dbName: 'kind', type: 'text' }, { name: '负责人', dbName: 'owner', type: 'text' }, { name: '状态', dbName: 'status', type: 'select', options: ['想法', '写作中', '已发布'] }] },
      { name: '发布计划', dbName: 'schedule', fields: [{ name: '日期', dbName: 'publish_on', type: 'date' }, { name: '选题', dbName: 'topic', type: 'link', linkTo: 'topics' }, { name: '渠道', dbName: 'channel', type: 'link', linkTo: 'channels' }] },
    ],
    seed: {
      channels: [{ name: '公众号', platform: '微信' }, { name: '视频号', platform: '微信' }, { name: '小红书', platform: '小红书' }],
      topics: [{ title: '新版功能解读', kind: '产品', owner: '小林', status: '已发布' }, { title: '客户案例:华东纸业', kind: '案例', owner: '小周', status: '写作中' }, { title: '行业趋势周报', kind: '资讯', owner: '小林', status: '想法' }],
      schedule: [{ publish_on: '2026-09-03', topic: '新版功能解读', channel: '公众号' }, { publish_on: '2026-09-05', topic: '客户案例:华东纸业', channel: '视频号' }, { publish_on: '2026-09-08', topic: '行业趋势周报', channel: '小红书' }],
    } },
]
