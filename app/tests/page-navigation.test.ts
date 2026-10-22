import { describe, expect, test } from 'bun:test'
import {
  createPageMemory,
  installPricingBackGuard,
  MAX_PAGE_POSITIONS,
  PAGE_NAVIGATION_KEY,
  PRICING_BACK_STATE_KEY,
  pagePath,
  pagePositionKey,
} from '../src/lib/page-navigation'

function store() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}
const at = (y: number) => ({ window: { x: 0, y }, areas: { settings: { x: 0, y: y + 20 } } })

describe('page navigation memory', () => {
  test('Stripe success, cancel and billing changes reuse the pricing scroll position after a full reload', () => {
    const storage = store(),
      before = createPageMemory(storage)
    before.enterPricing('/projects?view=starred')
    before.save('/pricing?billing=yearly', at(600))
    const returned = createPageMemory(storage)
    expect(returned.load('/pricing?billing=yearly&checkout=cs_test_123')).toEqual(at(600))
    expect(returned.load('/pricing?billing=monthly&canceled=1')).toEqual(at(600))
    expect(returned.pricingFrom()).toBe('/projects?view=starred')
  })
  test('return context retains app, filters and hash while removing old payment results', () => {
    const memory = createPageMemory(store())
    memory.enterPricing('/projects/demo?app=one&checkout=cs_old#section')
    expect(memory.pricingFrom()).toBe('/projects/demo?app=one#section')
    memory.enterPricing('/pricing?billing=yearly')
    expect(memory.pricingFrom()).toBe('/projects/demo?app=one#section')
    memory.save('/projects?view=starred', at(300))
    expect(memory.load('/projects?view=mine')).toBeUndefined()
    expect(memory.load('/projects?view=starred')).toEqual(at(300))
  })
  test('bounded cache evicts old pages and replaces a revisited page instead of growing', () => {
    const storage = store(),
      memory = createPageMemory(storage)
    for (let i = 0; i < 40; i++) memory.save('/projects/' + i, at(i))
    memory.save('/projects/20', at(999))
    const parsed = JSON.parse(storage.getItem(PAGE_NAVIGATION_KEY)!)
    expect(parsed.pages).toHaveLength(MAX_PAGE_POSITIONS)
    expect(memory.load('/projects/0')).toBeUndefined()
    expect(memory.load('/projects/20')).toEqual(at(999))
    expect(storage.getItem(PAGE_NAVIGATION_KEY)!.length).toBeLessThan(10_000)
  })
  test('unsafe return addresses, malformed storage and invalid coordinates are ignored', () => {
    for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/home\n', 'javascript:alert(1)'])
      expect(pagePath(path)).toBeUndefined()
    expect(pagePositionKey('/settings?canceled=true')).toBe('/settings')
    const storage = store()
    storage.setItem(PAGE_NAVIGATION_KEY, 'invalid-json')
    const memory = createPageMemory(storage)
    expect(memory.pricingFrom()).toBe('/home')
    memory.save('/settings', { window: { x: 0, y: NaN }, areas: {} })
    expect(memory.load('/settings')).toBeUndefined()
    storage.setItem(PAGE_NAVIGATION_KEY, JSON.stringify({ pages: [], pricingFrom: '//evil.test' }))
    expect(memory.pricingFrom()).toBe('/home')
  })
  test('storage quota failure preserves in-memory navigation without throwing', () => {
    const storage = store()
    const memory = createPageMemory({
      ...storage,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    memory.enterPricing('/settings')
    memory.save('/settings', at(500))
    expect(memory.load('/settings')).toEqual(at(500))
    expect(memory.pricingFrom()).toBe('/settings')
    memory.clear()
    expect(memory.pricingFrom()).toBe('/home')
    expect(memory.load('/settings')).toBeUndefined()
  })
  test('pricing browser back guard is idempotent and calls the shared return action once', () => {
    let state: unknown = { router: 'state' }
    const listeners = new Set<(event: Event) => void>()
    let pushes = 0
    const target = {
      history: {
        get state() {
          return state
        },
        replaceState(next: unknown) {
          state = next
        },
        pushState(next: unknown) {
          state = next
          pushes++
        },
      },
      location: { href: 'https://lovbase.invalid/pricing?billing=monthly' },
      addEventListener(_type: 'popstate', listener: (event: Event) => void) {
        listeners.add(listener)
      },
      removeEventListener(_type: 'popstate', listener: (event: Event) => void) {
        listeners.delete(listener)
      },
    }
    let returns = 0
    const cleanup = installPricingBackGuard(() => {
      returns++
    }, target)
    expect(pushes).toBe(1)
    expect((state as Record<string, unknown>)[PRICING_BACK_STATE_KEY]).toBe('sentinel')
    const unrelatedEvent = { state: { unrelated: true } } as PopStateEvent
    for (const listener of listeners) listener(unrelatedEvent)
    expect(returns).toBe(0)
    const baseEvent = { state: { [PRICING_BACK_STATE_KEY]: 'base' } } as PopStateEvent
    for (const listener of listeners) listener(baseEvent)
    expect(returns).toBe(1)
    for (const listener of listeners) listener(baseEvent)
    expect(returns).toBe(1)
    cleanup()
    expect(listeners).toHaveLength(0)
    installPricingBackGuard(() => {
      returns++
    }, target)
    expect(pushes).toBe(1)
  })
})
