import { betterAuth } from 'better-auth'
import type pg from 'pg'
import type { Provider } from '@nestjs/common'
import { ConfigService } from '../../config/config.service'
import { PG_POOL } from '../../database/pool.provider'

export const BETTER_AUTH = Symbol('BETTER_AUTH')
export type BetterAuth = ReturnType<typeof betterAuth>

/** Better Auth owns sessions, passwords and OAuth; its tables are created by SchemaService. */
export const authProvider: Provider = {
  provide: BETTER_AUTH,
  inject: [ConfigService, PG_POOL],
  useFactory: (cfg: ConfigService, pool: pg.Pool) =>
    betterAuth({
      database: pool,
      secret: cfg.env.BETTER_AUTH_SECRET,
      baseURL: cfg.env.BETTER_AUTH_URL,
      // A deployment usually has more than one hostname — the platform's and the real domain —
      // and only the canonical one is trusted unless the others are named.
      trustedOrigins: cfg.trustedOrigins,
      emailAndPassword: { enabled: true },
      // Behind Cloudflare in front of Railway, the socket address is the proxy's. Without this,
      // Better Auth cannot tell callers apart and rate limiting degrades to one shared bucket.
      advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] } },
      ...(cfg.env.GITHUB_CLIENT_ID
        ? {
            socialProviders: {
              github: { clientId: cfg.env.GITHUB_CLIENT_ID, clientSecret: cfg.env.GITHUB_CLIENT_SECRET! },
            },
          }
        : {}),
    }),
}
