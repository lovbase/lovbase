/** Allow only our template gallery return path, never an arbitrary external redirect. */
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
export function authSearch(s: Record<string, unknown>): { error?: string; returnTo?: string } {
  return { error: typeof s.error === 'string' ? s.error : undefined, returnTo: templateReturn(s.returnTo) }
}
