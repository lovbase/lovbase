import { describe, expect, test } from 'bun:test'
import { ConfigService } from '../src/config/config.service'

// The dev defaults are a convenience for `bun run dev` and a hazard for a deployment, because this
// repository is public: every default below is a value an attacker can simply read. These tests
// are the reason a deploy that forgets one fails loudly instead of running with a known secret.

const prod = (over: Record<string, string | undefined> = {}) =>
  ConfigService.of({
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: 'a-real-secret-from-openssl',
    SQL_ROLE_PASSWORD: 'a-real-password',
    SANDBOX_INTERNAL_TOKEN: 'a-real-token',
    ...over,
  })

describe('production refuses the development defaults', () => {
  test('the auth secret, which derives the key that encrypts users API keys', () => {
    expect(() => prod({ BETTER_AUTH_SECRET: 'dev-only-secret-change-me' }))
      .toThrow(/BETTER_AUTH_SECRET/)
  })

  test('the SQL role password', () => {
    expect(() => prod({ SQL_ROLE_PASSWORD: 'lovbase_sql' })).toThrow(/SQL_ROLE_PASSWORD/)
  })

  test('the sandbox token, which is the only thing guarding that API', () => {
    expect(() => prod({ SANDBOX_INTERNAL_TOKEN: 'dev-internal-token' })).toThrow(/SANDBOX_INTERNAL_TOKEN/)
  })

  test('names every one that is wrong, not just the first', () => {
    const err = (() => {
      try {
        prod({ BETTER_AUTH_SECRET: 'dev-only-secret-change-me', SQL_ROLE_PASSWORD: 'lovbase_sql' })
        return ''
      } catch (e) { return e instanceof Error ? e.message : String(e) }
    })()
    expect(err).toContain('BETTER_AUTH_SECRET')
    expect(err).toContain('SQL_ROLE_PASSWORD')
    // A deploy should be fixable in one pass rather than one variable per failed boot.
    expect(err).toContain('openssl rand')
  })

  test('a fully configured production environment starts', () => {
    expect(prod().isProduction).toBe(true)
  })
})

describe('development keeps its defaults', () => {
  test('so `bun run dev` needs no setup at all', () => {
    const cfg = ConfigService.of({})
    expect(cfg.isProduction).toBe(false)
    expect(cfg.env.BETTER_AUTH_SECRET).toBe('dev-only-secret-change-me')
  })
})

describe('trustedOrigins', () => {
  test('always includes the canonical URL, so the common case needs no configuration', () => {
    expect(prod({ BETTER_AUTH_URL: 'https://lovbase.dev' }).trustedOrigins).toEqual(['https://lovbase.dev'])
  })

  test('adds the extras, which is what a second hostname needs', () => {
    const cfg = prod({
      BETTER_AUTH_URL: 'https://lovbase.dev',
      BETTER_AUTH_TRUSTED_ORIGINS: 'https://x.up.railway.app, https://staging.lovbase.dev',
    })
    expect(cfg.trustedOrigins).toEqual([
      'https://lovbase.dev',
      'https://x.up.railway.app',
      'https://staging.lovbase.dev',
    ])
  })

  test('tolerates stray commas and spaces, and never lists one twice', () => {
    const cfg = prod({
      BETTER_AUTH_URL: 'https://lovbase.dev',
      BETTER_AUTH_TRUSTED_ORIGINS: ' , https://lovbase.dev ,, https://other.dev , ',
    })
    expect(cfg.trustedOrigins).toEqual(['https://lovbase.dev', 'https://other.dev'])
  })
})

describe('storageConfigured', () => {
  test('needs all three, so nothing else has to check them one at a time', () => {
    expect(prod().storageConfigured).toBe(false)
    expect(prod({ S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com' }).storageConfigured).toBe(false)
    expect(prod({
      S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
    }).storageConfigured).toBe(true)
  })
})
