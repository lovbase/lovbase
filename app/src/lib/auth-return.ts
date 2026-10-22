import { safeReturnTo } from './return-to'

/** Preserve the template gallery's canonical remix return path. */
export function templateReturn(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/templates?')) return undefined
  try {
    const url = new URL(value, 'https://lovbase.invalid')
    if (url.origin !== 'https://lovbase.invalid' || url.pathname !== '/templates') return undefined
    const template = url.searchParams.get('template')
    if (template !== 'inventory') return undefined
    return '/templates?template=inventory&remix=1'
  } catch {
    return undefined
  }
}
/** Both login entry points share the same allowlist, including social-login callbacks. */
export function authReturn(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const url = new URL(safeReturnTo(value), 'https://lovbase.invalid')
    if (url.pathname === '/pricing' && url.searchParams.get('plan') === 'pro')
      return `/pricing?plan=pro&billing=${url.searchParams.get('billing') === 'yearly' ? 'yearly' : 'monthly'}`
  }
  const template = templateReturn(value)
  if (template) return template
  const path = safeReturnTo(value)
  const url = new URL(path, 'https://lovbase.invalid')
  const request = url.searchParams.get('request')
  if (url.pathname === '/mcp/authorize' && request && /^[A-Za-z0-9_-]{43}$/.test(request))
    return `/mcp/authorize?request=${request}`
  return undefined
}
export function authSearch(s: Record<string, unknown>): { error?: string; returnTo?: string } {
  return { error: typeof s.error === 'string' ? s.error : undefined, returnTo: authReturn(s.returnTo) }
}
