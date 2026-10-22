import { describe, test, expect } from 'bun:test'
import { billingReturnPath, generationPriority, PRIORITY_AGE_MS } from '../src/entitlements'
import { PLANS } from '../src/plans'

describe('plan entitlements and payment return paths', () => {
  test('Free and Pro benefits have one authoritative definition', () => {
    expect(PLANS.free).toMatchObject({
      credits: 30,
      projects: 2,
      storageMb: 200,
      publishedApps: 1,
      exports: false,
      directDatabase: false,
      priority: false,
    })
    expect(PLANS.pro).toMatchObject({
      credits: 500,
      projects: 25,
      storageMb: 5000,
      publishedApps: 25,
      exports: true,
      directDatabase: true,
      priority: true,
    })
  })
  test('payment return paths cannot redirect off-site or carry arbitrary parameters', () => {
    expect(billingReturnPath('/projects/a123?app=b123')).toBe('/projects/a123?app=b123')
    expect(billingReturnPath('/home')).toBe('/home')
    expect(billingReturnPath('/pricing?billing=monthly')).toBe('/pricing?billing=monthly')
    expect(billingReturnPath('/pricing?billing=yearly')).toBe('/pricing?billing=yearly')
    for (const path of [
      'https://evil.test',
      '//evil.test',
      '/projects/../login',
      '/projects/a?redirect=https://evil.test',
      '/\\evil.test',
      '/settings#evil',
      '/pricing?billing=yearly&returnTo=https://evil.test',
    ])
      expect(() => billingReturnPath(path)).toThrow()
  })
  test('Free tasks age into the priority tier after ten minutes', () => {
    expect(generationPriority('pro', 100, 100)).toBe(1)
    expect(generationPriority('free', 100, 100 + PRIORITY_AGE_MS - 1)).toBe(2)
    expect(generationPriority('free', 100, 100 + PRIORITY_AGE_MS)).toBe(1)
  })
})
