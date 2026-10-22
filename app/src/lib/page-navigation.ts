/** Tiny, tab-scoped navigation memory. Never stores page content or editor/chat state. */
export const PAGE_NAVIGATION_KEY = 'lovbase:page-navigation:v1'
export const MAX_PAGE_POSITIONS = 30
export const PRICING_BACK_STATE_KEY = '__lovbasePricingBack'
type Point = { x: number; y: number }
export type PagePosition = { window: Point; areas: Record<string, Point> }
type Memory = { pages: { path: string; position: PagePosition }[]; pricingFrom?: string }
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function tabStorage(): Store | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

/** Reject external/ambiguous URLs even if session storage has been edited. */
export function pagePath(path: string): string | undefined {
  if (
    path.length > 2048 ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    [...path].some((c) => c === '\\' || c.charCodeAt(0) <= 32)
  )
    return undefined
  try {
    const url = new URL(path, 'https://lovbase.invalid')
    if (url.origin !== 'https://lovbase.invalid') return undefined
    for (const key of ['checkout', 'canceled']) url.searchParams.delete(key)
    return url.pathname + url.search + url.hash
  } catch {
    return undefined
  }
}

export function pagePositionKey(path: string): string | undefined {
  const clean = pagePath(path)
  return clean?.split(/[?#]/)[0] === '/pricing' ? '/pricing' : clean
}

function point(value: unknown): value is Point {
  const p = value as Point | undefined
  return !!p && [p.x, p.y].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10_000_000)
}
function position(value: unknown): value is PagePosition {
  const p = value as PagePosition | undefined
  return (
    !!p &&
    point(p.window) &&
    !!p.areas &&
    typeof p.areas === 'object' &&
    Object.keys(p.areas).length <= 8 &&
    Object.entries(p.areas).every(([key, entry]) => /^[a-z-]{1,40}$/.test(key) && point(entry))
  )
}

export function createPageMemory(storage: Store | undefined = tabStorage()) {
  let fallback: Memory = { pages: [] }
  const read = (): Memory => {
    try {
      const value = storage?.getItem(PAGE_NAVIGATION_KEY)
      if (!value) return fallback
      const parsed = JSON.parse(value) as Memory
      if (!Array.isArray(parsed.pages)) return fallback
      return {
        pages: parsed.pages
          .filter((p) => typeof p.path === 'string' && pagePositionKey(p.path) === p.path && position(p.position))
          .slice(-MAX_PAGE_POSITIONS),
        pricingFrom: typeof parsed.pricingFrom === 'string' ? pagePath(parsed.pricingFrom) : undefined,
      }
    } catch {
      return fallback
    }
  }
  const write = (value: Memory) => {
    fallback = value
    try {
      storage?.setItem(PAGE_NAVIGATION_KEY, JSON.stringify(value))
    } catch {
      storage = undefined
    }
  }
  return {
    save(path: string, value: PagePosition) {
      const key = pagePositionKey(path)
      if (!key || !position(value)) return
      const state = read()
      state.pages = [...state.pages.filter((p) => p.path !== key), { path: key, position: value }].slice(
        -MAX_PAGE_POSITIONS,
      )
      write(state)
    },
    load(path: string): PagePosition | undefined {
      return read().pages.find((p) => p.path === pagePositionKey(path))?.position
    },
    enterPricing(from: string) {
      const path = pagePath(from)
      if (!path || /^\/(pricing|login|signup)(?:[/?#]|$)/.test(path)) return
      write({ ...read(), pricingFrom: path })
    },
    pricingFrom(): string {
      const from = read().pricingFrom
      return from && !/^\/(pricing|login|signup|api)(?:[/?#]|$)/.test(from) ? from : '/home'
    },
    clear() {
      fallback = { pages: [] }
      try {
        storage?.removeItem(PAGE_NAVIGATION_KEY)
      } catch {
        /* Best effort. */
      }
    },
  }
}

// Lazy: no browser state is created or shared by server rendering.
let memory: ReturnType<typeof createPageMemory> | undefined
export function pageMemory() {
  return (memory ??= createPageMemory())
}

export function capturePagePosition(): PagePosition {
  const areas: Record<string, Point> = {}
  for (const area of Array.from(document.querySelectorAll<HTMLElement>('[data-page-scroll]')).slice(0, 8)) {
    const id = area.dataset.pageScroll!
    if (/^[a-z-]{1,40}$/.test(id)) areas[id] = { x: Math.max(0, area.scrollLeft), y: Math.max(0, area.scrollTop) }
  }
  return { window: { x: Math.max(0, window.scrollX), y: Math.max(0, window.scrollY) }, areas }
}

/** Save synchronously before leaving for Checkout, including the last unthrottled scroll. */
export function savePagePosition() {
  pageMemory().save(window.location.pathname + window.location.search + window.location.hash, capturePagePosition())
}

type PricingBackTarget = Pick<Window, 'history' | 'location' | 'addEventListener' | 'removeEventListener'>

function pricingBackState(state: unknown, kind: 'base' | 'sentinel') {
  const current = state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {}
  return { ...current, [PRICING_BACK_STATE_KEY]: kind }
}

/**
 * Adds one in-document history entry so browser Back can use the same return action as the
 * pricing page button. The base entry is marked as well because popstate exposes the entry we
 * landed on, not the sentinel entry that was popped.
 */
export function installPricingBackGuard(onBack: () => void, target?: PricingBackTarget): () => void {
  const host = target ?? (typeof window === 'undefined' ? undefined : window)
  if (!host) return () => {}

  const current = host.history.state as Record<string, unknown> | null
  if (current?.[PRICING_BACK_STATE_KEY] !== 'sentinel') {
    try {
      const base = pricingBackState(current, 'base')
      host.history.replaceState(base, '', host.location.href)
      host.history.pushState(pricingBackState(base, 'sentinel'), '', host.location.href)
    } catch {
      return () => {}
    }
  }

  let consumed = false
  const onPopState = (event: Event) => {
    const state = (event as PopStateEvent).state
    if (
      consumed ||
      !state ||
      typeof state !== 'object' ||
      (state as Record<string, unknown>)[PRICING_BACK_STATE_KEY] !== 'base'
    )
      return
    consumed = true
    onBack()
  }
  host.addEventListener('popstate', onPopState)
  return () => host.removeEventListener('popstate', onPopState)
}
