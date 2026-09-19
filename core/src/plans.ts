// Single source of truth for plans, prices and credit costs.
// Read by the pricing page, the sidebar, the admin console and the server-side meter.

export type Plan = 'free' | 'pro' | 'business'

export type PlanSpec = {
  id: Plan
  name: string
  tagline: string
  /** USD per month, billed monthly. */
  price: number
  /** USD per month when billed yearly (per month equivalent). */
  yearlyPrice: number
  /** Message credits granted at the start of each billing period. */
  credits: number
  projects: number
  storageMb: number
  /** Bring your own model endpoint and key. Paid plans only. */
  byok: boolean
  /** Choose the published subdomain instead of taking the app id. Paid plans only. */
  customSubdomain: boolean
  /** English copy for the same plan; the fields above stay the Chinese source. */
  en: { tagline: string; features: string[] }
  features: string[]
  /** Shown with a highlight on the pricing page. */
  featured?: boolean
}

export const PLANS: Record<Plan, PlanSpec> = {
  free: {
    id: 'free',
    name: 'Free',
    tagline: '试一试,看看它能建出什么',
    price: 0,
    yearlyPrice: 0,
    credits: 30,
    projects: 2,
    storageMb: 200,
    byok: false,
    customSubdomain: false,
    features: [
      '每月 30 次对话额度',
      '2 个项目,200 MB 数据',
      '真实 Postgres 表与数据 API',
      '公开分享链接',
    ],
    en: {
      tagline: 'Try it and see what it builds',
      features: [
        '30 messages a month',
        '2 projects, 200 MB of data',
        'Real Postgres tables and a data API',
        'Public share links',
      ],
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: '给认真做产品的人',
    price: 25,
    yearlyPrice: 20,
    credits: 500,
    projects: 25,
    storageMb: 5000,
    byok: true,
    customSubdomain: true,
    featured: true,
    features: [
      '每月 500 次对话额度',
      '25 个项目,5 GB 数据',
      'BYOK:自带模型与 key',
      '数据库直连(只读账号)',
      '自定义子域名发布',
      '导出 SQL 与项目源码',
      '优先生成队列',
    ],
    en: {
      tagline: 'For people shipping something real',
      features: [
        '500 messages a month',
        '25 projects, 5 GB of data',
        'BYOK: your own model and key',
        'Direct database access (read-only role)',
        'Publish on a subdomain you choose',
        'Export SQL and project source',
        'Priority generation queue',
      ],
    },
  },
  business: {
    id: 'business',
    name: 'Business',
    tagline: '团队与生产负载',
    price: 99,
    yearlyPrice: 82,
    credits: 2500,
    projects: 200,
    storageMb: 50000,
    byok: true,
    customSubdomain: true,
    features: [
      '每月 2500 次对话额度',
      '200 个项目,50 GB 数据',
      'BYOK:自带模型与 key',
      '独立数据库实例',
      '私有化 / 自托管沙箱',
      'SSO 与审计日志',
      '专属支持',
    ],
    en: {
      tagline: 'Teams and production workloads',
      features: [
        '2500 messages a month',
        '200 projects, 50 GB of data',
        'BYOK: your own model and key',
        'Dedicated database instance',
        'Self-hosted sandbox',
        'SSO and audit logs',
        'Dedicated support',
      ],
    },
  },
}

export const PLAN_IDS: Plan[] = ['free', 'pro', 'business']
export const planOf = (p?: string | null): PlanSpec => PLANS[(p as Plan) ?? 'free'] ?? PLANS.free

// ── Credits ──
// One credit = one agent turn. Building the UI runs a coding agent in a container for minutes,
// so it costs more than a schema tweak. Kept coarse on purpose: users must be able to predict it.
export const CREDIT_COST = {
  message: 1,
  build_app: 5,
} as const
export type CreditKind = keyof typeof CREDIT_COST

export const CREDIT_LABEL: Record<CreditKind, string> = {
  message: '对话',
  build_app: '生成界面',
}

/** Plan copy in the reader's language; everything else on a plan is language-neutral. */
export const planCopy = (p: PlanSpec, locale: 'zh' | 'en') =>
  locale === 'en' ? { tagline: p.en.tagline, features: p.en.features } : { tagline: p.tagline, features: p.features }
