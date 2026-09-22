import { betterAuth } from 'better-auth'
import { captcha } from 'better-auth/plugins'
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
      // Someone who signed up with a password and later clicks "continue with GitHub" is the same
      // person, and Better Auth's default is to refuse (`account_not_linked`) rather than to join
      // the two. GitHub and Google both verify the email they report, so an OAuth identity that
      // carries the same address may attach to the existing user.
      account: { accountLinking: { enabled: true, trustedProviders: ['github', 'google'] } },
      // Behind Cloudflare in front of Railway, the socket address is the proxy's. Without this,
      // Better Auth cannot tell callers apart and rate limiting degrades to one shared bucket.
      advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'] } },
      // Each provider appears only when both halves of its credentials are set; the sign-in page
      // asks `authOptions` which buttons to draw, so a half-configured provider is invisible
      // rather than a button that fails.
      socialProviders: {
        ...(cfg.authOptions.github
          ? { github: { clientId: cfg.env.GITHUB_CLIENT_ID!, clientSecret: cfg.env.GITHUB_CLIENT_SECRET! } }
          : {}),
        ...(cfg.authOptions.google
          ? { google: { clientId: cfg.env.GOOGLE_CLIENT_ID!, clientSecret: cfg.env.GOOGLE_CLIENT_SECRET! } }
          : {}),
      },
      // Turnstile on the email endpoints (sign-up, sign-in, password reset — the plugin's default
      // list). The browser sends the widget's token as `x-captcha-response`; a request without a
      // valid one is refused before a password is ever checked. Social sign-in is not gated: the
      // provider already did that work.
      plugins: cfg.authOptions.turnstileSiteKey
        ? [captcha({ provider: 'cloudflare-turnstile', secretKey: cfg.env.TURNSTILE_SECRET_KEY! })]
        : [],
    }),
}
