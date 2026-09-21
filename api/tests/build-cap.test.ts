import { describe, expect, test } from 'bun:test'
import { ConfigService } from '../src/config/config.service'

// The cap the application enforces, so it can be turned down from a dashboard without deploying
// the Worker whose max_instances is the hard ceiling. Getting the parse wrong turns a cost control
// into either an outage (0) or no control at all (NaN).

describe('MAX_ACTIVE_BUILDS', () => {
  test('defaults to the hard ceiling in wrangler.jsonc, so unset is not unlimited', () => {
    expect(ConfigService.of({}).maxActiveBuilds).toBe(2)
  })

  test('reads a number from the string an environment always gives', () => {
    expect(ConfigService.of({ MAX_ACTIVE_BUILDS: '5' } as never).maxActiveBuilds).toBe(5)
  })

  test('refuses zero — a cap of none is an outage, not a setting', () => {
    expect(() => ConfigService.of({ MAX_ACTIVE_BUILDS: '0' } as never)).toThrow()
  })

  test('refuses a fraction and refuses nonsense, rather than silently becoming NaN', () => {
    expect(() => ConfigService.of({ MAX_ACTIVE_BUILDS: '1.5' } as never)).toThrow()
    expect(() => ConfigService.of({ MAX_ACTIVE_BUILDS: 'lots' } as never)).toThrow()
  })
})
