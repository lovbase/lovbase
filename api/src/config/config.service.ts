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

  // Object storage for chat attachments. Any S3 API will do: R2 in the hosted product, MinIO in
  // the self-hosted compose file. Unset means attachments stay inline, which still works — it is
  // just the thing that puts base64 in Postgres, so production should always set these.
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().default('lovbase-uploads'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // R2 wants "auto"; a real AWS region is only meaningful on AWS itself.
  S3_REGION: z.string().default('auto'),
})

export type Env = z.infer<typeof Env>

/**
 * Secrets that have a development default, and must not keep it in production.
 *
 * The defaults exist so `bun run dev` works with no setup, and that convenience is worth keeping
 * — but this repository is public, so every one of these values is known to anyone who reads it.
 * `BETTER_AUTH_SECRET` is the sharp one: it derives the key that encrypts users' own provider
 * API keys, so shipping with the default means shipping them encrypted under a published string.
 *
 * Zod validates shape, which cannot catch "you forgot to change this". This can.
 */
const DEV_DEFAULTS: Record<string, string> = {
  BETTER_AUTH_SECRET: 'dev-only-secret-change-me',
  SQL_ROLE_PASSWORD: 'lovbase_sql',
  SANDBOX_INTERNAL_TOKEN: 'dev-internal-token',
}

function parse(source: Record<string, string | undefined>): Env {
  const parsed = Env.safeParse(source)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`环境变量不合法:\n${lines.join('\n')}`)
  }
  const env = parsed.data
  if (env.NODE_ENV === 'production') {
    const unchanged = Object.entries(DEV_DEFAULTS)
      .filter(([k, dev]) => (env as unknown as Record<string, unknown>)[k] === dev)
      .map(([k]) => k)
    if (unchanged.length)
      // Refuse to start rather than warn: a warning in a deploy log is a warning nobody reads,
      // and the failure it precedes is silent for as long as it takes someone to notice.
      throw new Error(
        `以下变量还是开发默认值,生产环境必须改掉(这些默认值在开源仓库里是公开的):\n` +
        unchanged.map((k) => `  ${k}`).join('\n') +
        `\n生成一个:openssl rand -base64 32`,
      )
  }
  return env
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
  /** Attachments are only offloaded when there is somewhere to put them. */
  get storageConfigured() {
    return !!(this.env.S3_ENDPOINT && this.env.S3_ACCESS_KEY_ID && this.env.S3_SECRET_ACCESS_KEY)
  }
  /** Dev has a default sandbox URL; production must be told explicitly. */
  get sandboxConfigured() { return !!this.env.SANDBOX_URL || !this.isProduction }
  /** Local default is the Docker runner on 8788, which is what README and .env.example describe.
   *  Point it at 8787 explicitly when running the Cloudflare Worker via `wrangler dev` instead. */
  get sandboxUrl() { return this.env.SANDBOX_URL ?? 'http://localhost:8788' }
  get adminEmails() { return this.env.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean) }
  get quotaMb(): Record<string, number> { return { free: this.env.FREE_QUOTA_MB, pro: this.env.PRO_QUOTA_MB } }

  stripePriceId(plan: string, yearly: boolean): string {
    return process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${yearly ? 'YEARLY' : 'MONTHLY'}`] ?? ''
  }

  appUrl(slug: string) { return `https://${slug}.${this.env.APPS_DOMAIN}` }
}
