import { mimeFor } from './backend'

/** HTML and public/ files can change at the same URL; only fingerprinted assets are immutable. */
export function publishedCacheControl(key: string) {
  return /^assets\/.+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(key) && !key.endsWith('.html')
    ? 'public, max-age=31536000, immutable' : 'no-cache'
}

/**
 * A snapshot is reachable only through its signed host, so the visitor's own browser may keep the
 * fingerprinted assets; nothing shared may, and the document is always fetched again.
 */
export function snapshotCacheControl(key: string) {
  return publishedCacheControl(key) === 'no-cache' ? 'private, no-store' : 'private, max-age=31536000, immutable'
}

export async function servePublished(bucket: Pick<R2Bucket, 'get'>, slug: string, pathname: string): Promise<Response | null> {
  if (slug === 'snap' || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) return null
  let clean: string
  try { clean = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html' }
  catch { return new Response('bad path', { status: 400 }) }
  if (clean.includes('..') || clean.includes('\\') || [...clean].some(char => char.charCodeAt(0) < 32)) return new Response('bad path', { status: 400 })
  const hit = (await bucket.get(`${slug}/${clean}`))
    ?? (!clean.split('/').at(-1)!.includes('.') ? await bucket.get(`${slug}/index.html`) : null)
  if (!hit) return new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const key = hit.key.slice(slug.length + 1)
  return new Response(hit.body, { headers: {
    'Content-Type': mimeFor(key), 'Cache-Control': key.endsWith('.html') ? 'no-store' : publishedCacheControl(key),
    'X-Content-Type-Options': 'nosniff',
  } })
}
