/** Only known application routes may receive a payment return. Never accepts an origin. */
export function billingReturnPath(path?: string): string | undefined {
  if (path === undefined) return undefined
  if (path === '/home' || path === '/settings' || path === '/pricing') return path
  if (/^\/pricing\?billing=(monthly|yearly)$/.test(path)) return path
  if (/^\/projects\/[A-Za-z0-9_-]+(?:\?app=[A-Za-z0-9_-]+)?$/.test(path)) return path
  throw new Error('Invalid payment return path')
}

export const PRIORITY_AGE_MS = 10 * 60_000
export function generationPriority(plan: string, createdAt: number, now = Date.now()) {
  return plan !== 'free' || now - createdAt >= PRIORITY_AGE_MS ? 1 : 2
}
