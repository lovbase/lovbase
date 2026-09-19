import { Injectable } from '@nestjs/common'
import { z } from 'zod'

// ── Every environment variable the backend reads, in one place ──
// Before this module they were scattered across ten files, each with its own inline default, so
// nothing failed until the code path that needed a missing value ran. Now the shape is declared
// once and parsed at boot: a typo in a Railway variable is a startup error, not a 500 at 3am.

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3008),

  DATABASE_URL: z.string().default('postgres://lovbase:lovbase@localhost:5433/lovbase'),
  DATABASE_SQL_URL: z.string().optional(),
  PG_POOL_MAX: z.coerce.number().default(10),
  PG_SQL_POOL_MAX: z.coerce.number().default(10),
  SQL_ROLE_PASSWORD: z.string().default('lovbase_sql'),

  BETTER_AUTH_SECRET: z.string().default('dev-only-secret-change-me'),
  BETTER_AUTH_URL: z.string().default('http://localhost:3008'),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  ADMIN_EMAILS: z.string().default(''),

  SANDBOX_URL: z.string().optional(),
  SANDBOX_INTERNAL_TOKEN: z.string().default('dev-internal-token'),
  APPS_DOMAIN: z.string().default('lovbase.app'),

  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  WS_RATE_PER_MIN: z.coerce.number().default(300),
  FREE_QUOTA_MB: z.coerce.number().default(200),
  PRO_QUOTA_MB: z.coerce.number().default(5000),

  POSTHOG_API_HOST: z.string().default('us.i.posthog.com'),
  POSTHOG_ASSET_HOST: z.string().default('us-assets.i.posthog.com'),
})

export type Env = z.infer<typeof Env>

function parse(source: Record<string, string | undefined>): Env {
  const parsed = Env.safeParse(source)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`环境变量不合法:\n${lines.join('\n')}`)
  }
  return parsed.data
}

@Injectable()
export class ConfigService {
  readonly env: Env = parse(process.env)

  /** Tests build one from a literal instead of the ambient environment. */
  static of(source: Record<string, string | undefined>): ConfigService {
    const cfg = new ConfigService()
    Object.assign(cfg, { env: parse(source) })
    return cfg
  }

  get isProduction() { return this.env.NODE_ENV === 'production' }

  /** Connection string for the low-privilege executor role used by the data API. */
  get sqlUrl(): string {
    if (this.env.DATABASE_SQL_URL) return this.env.DATABASE_SQL_URL
    const u = new URL(this.env.DATABASE_URL)
    u.username = 'lovbase_sql'
    u.password = this.env.SQL_ROLE_PASSWORD
    return u.toString()
  }

  get billingEnabled() { return !!this.env.STRIPE_SECRET_KEY }
  /** Dev has a default sandbox URL; production must be told explicitly. */
  get sandboxConfigured() { return !!this.env.SANDBOX_URL || !this.isProduction }
  get sandboxUrl() { return this.env.SANDBOX_URL ?? 'http://localhost:8787' }
  get adminEmails() { return this.env.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean) }
  get quotaMb(): Record<string, number> { return { free: this.env.FREE_QUOTA_MB, pro: this.env.PRO_QUOTA_MB } }

  stripePriceId(plan: string, yearly: boolean): string {
    return process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${yearly ? 'YEARLY' : 'MONTHLY'}`] ?? ''
  }

  appUrl(slug: string) { return `https://${slug}.${this.env.APPS_DOMAIN}` }
}
