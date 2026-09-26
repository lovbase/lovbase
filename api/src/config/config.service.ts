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
  REDIS_URL: z.string().url().regex(/^rediss?:\/\//).default('redis://localhost:6379'),
  RUN_CHUNKS_TTL_SECONDS: z.coerce.number().int().min(60).default(7200),
  RUN_CHUNKS_MAX_BYTES: z.coerce.number().int().min(8192).default(32 * 1024 * 1024),
  TURN_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(20),
  SANDBOX_SLOT_COUNT: z.coerce.number().int().min(1).max(100).default(5),
  SANDBOX_LEASE_TTL_SECONDS: z.coerce.number().int().min(15).default(45),
  SANDBOX_LEASE_RENEW_SECONDS: z.coerce.number().int().min(1).default(10),
  CONTAINER_WARM_GRACE_SECONDS: z.coerce.number().int().min(10).default(120),

  BETTER_AUTH_SECRET: z.string().default('dev-only-secret-change-me'),
  BETTER_AUTH_URL: z.string().default('http://localhost:3008'),
  /**
   * Extra origins allowed to call the auth endpoints, comma-separated.
   *
   * Better Auth accepts only `BETTER_AUTH_URL`'s origin by default, so the moment a deployment
   * gains a second hostname — a custom domain in front of the platform's own, a staging alias —
   * every sign-in from the other one fails with "Invalid origin" and nothing else explains why.
   */
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().default(''),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /**
   * Cloudflare Turnstile, in front of email sign-up / sign-in. Both keys or neither: the site
   * key goes to the browser to draw the widget, the secret verifies its token here. Unset means
   * no challenge, which is right for a private deployment and wrong for a public one.
   */
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
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
  /**
   * The bucket the sandbox writes published apps and build snapshots into — its own R2 binding,
   * not the uploads bucket. Read-only from here, and only for snapshots: a published app is served
   * by the Worker, a snapshot is private and comes back through `/api/snap/:appId/*`.
   */
  SANDBOX_BUCKET: z.string().default(''),
  /**
   * ...and the endpoint that bucket answers on, when it is not the uploads bucket's.
   *
   * R2 addresses a bucket through its jurisdiction: `<account>.r2.…` for the default one,
   * `<account>.us.r2.…` and `<account>.eu.r2.…` for the others, and a bucket is invisible on any
   * endpoint but its own — the same credentials return `NoSuchBucket` rather than a permission
   * error, which reads like the bucket is gone. Two buckets in one account need not share a
   * jurisdiction, and here they do not. Empty means "the same endpoint as the uploads bucket".
   */
  SANDBOX_S3_ENDPOINT: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // R2 wants "auto"; a real AWS region is only meaningful on AWS itself.
  S3_REGION: z.string().default('auto'),

  // Traffic for published apps comes from Cloudflare, which already counts page loads per
  // hostname — each app is its own subdomain — so the numbers arrive split by app with nothing of
  // ours running inside anyone's generated application. The token needs Analytics · Read, which
  // the one that deploys the Worker does not have; the account id is the same one the Worker uses.
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),

  // How many builds may run at once. The hard ceiling is `max_instances` in
  // sandbox/wrangler.jsonc, which is Cloudflare's and needs a Worker deploy to change; this is the
  // one the application enforces, so it can be turned down from the Railway dashboard in a moment
  // — during an incident, or while watching the bill — without deploying anything. Keep it at or
  // below the hard ceiling: above it, the extra turns queue inside Cloudflare instead, where the
  // user sees a stall rather than a sentence explaining it.
  MAX_ACTIVE_BUILDS: z.coerce.number().int().min(1).default(2),
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
    throw new Error(`Invalid environment variables:\n${lines.join('\n')}`)
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
        `These variables still hold their development defaults; production must change them (the defaults are public in the open-source repository):\n` +
        unchanged.map((k) => `  ${k}`).join('\n') +
        `\nGenerate one with: openssl rand -base64 32`,
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

  get maxActiveBuilds() { return this.env.MAX_ACTIVE_BUILDS }

  /** Without both, the analytics pane says so rather than showing zeroes that look like no traffic. */
  get edgeAnalyticsConfigured() {
    return !!(this.env.CLOUDFLARE_API_TOKEN && this.env.CLOUDFLARE_ACCOUNT_ID)
  }
  /** Local default is the Docker runner on 8788, which is what README and .env.example describe.
   *  Point it at 8787 explicitly when running the Cloudflare Worker via `wrangler dev` instead. */
  get sandboxUrl() { return this.env.SANDBOX_URL ?? 'http://localhost:8788' }
  /** Every origin the auth endpoints accept: the canonical one, plus any extras configured. */
  get trustedOrigins(): string[] {
    const extra = this.env.BETTER_AUTH_TRUSTED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    return [...new Set([this.env.BETTER_AUTH_URL, ...extra])]
  }

  /** What the sign-in page may offer: which social providers are configured, and the captcha's public key. */
  get authOptions() {
    return {
      github: !!(this.env.GITHUB_CLIENT_ID && this.env.GITHUB_CLIENT_SECRET),
      google: !!(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET),
      turnstileSiteKey: this.env.TURNSTILE_SITE_KEY && this.env.TURNSTILE_SECRET_KEY ? this.env.TURNSTILE_SITE_KEY : null,
    }
  }
  get adminEmails() { return this.env.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean) }
  get quotaMb(): Record<string, number> { return { free: this.env.FREE_QUOTA_MB, pro: this.env.PRO_QUOTA_MB } }

  stripePriceId(plan: string, yearly: boolean): string {
    return process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${yearly ? 'YEARLY' : 'MONTHLY'}`] ?? ''
  }

  /** One-off credit packs: STRIPE_PRICE_CREDITS_SMALL and friends, one per pack id. */
  stripeCreditPriceId(pack: string): string {
    return process.env[`STRIPE_PRICE_CREDITS_${pack.toUpperCase()}`] ?? ''
  }

  appUrl(slug: string) { return `https://${slug}.${this.env.APPS_DOMAIN}` }
  /** Snapshots need the sandbox's bucket and credentials to read it; without both there are none. */
  get snapshotsConfigured() { return !!this.env.SANDBOX_BUCKET && this.storageConfigured }
  /** Where to reach the sandbox's bucket. Its own jurisdiction endpoint, or the uploads one. */
  get sandboxEndpoint() { return this.env.SANDBOX_S3_ENDPOINT || this.env.S3_ENDPOINT || '' }
}
