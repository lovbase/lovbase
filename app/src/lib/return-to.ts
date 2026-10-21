/** Never let a login return URL turn into an external redirect. */
export function safeReturnTo(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted paths.
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20]/.test(value)) return '/home'
  try {
    const url = new URL(value,'https://lovbase.invalid')
    if (url.origin !== 'https://lovbase.invalid') return '/home'
    return url.pathname + url.search + url.hash
  } catch { return '/home' }
}
