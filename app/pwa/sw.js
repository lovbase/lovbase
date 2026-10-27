/* Build placeholders are replaced by pwa/plugin.ts. No private responses enter these caches. */
const offlineCache = 'lovbase-offline-__PWA_VERSION__'
const assetCache = 'lovbase-assets-v1'
const publicFiles = __PWA_PUBLIC_FILES__
const assets = new Set(__PWA_ASSETS__)

self.addEventListener('install', event => {
  event.waitUntil(caches.open(offlineCache).then(cache => cache.addAll(
    publicFiles.map(path => new Request(path, { cache: 'reload' })),
  )))
  // An update waits until the user accepts it, or all old windows have closed.
})

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting())
})

self.addEventListener('push', event => {
  let data = {}
  try { data = event.data?.json() || {} } catch { data = {} }
  const title = typeof data.title === 'string' ? data.title : 'Lovbase task completed'
  const body = typeof data.body === 'string' ? data.body : 'Your application is ready.'
  const raw = typeof data.url === 'string' ? data.url : '/home'
  let url
  try { url = new URL(raw, self.location.origin) } catch { url = new URL('/home', self.location.origin) }
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/projects/')) url = new URL('/home', self.location.origin)
  event.waitUntil(self.registration.showNotification(title, {
    body, tag: typeof data.tag === 'string' ? data.tag : undefined,
    icon: '/icons/icon-192.png', data: { url: url.href },
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/home', self.location.origin)
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/projects/')) return
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find(client => client.url === url.href)
    if (existing) await existing.focus()
    else await self.clients.openWindow(url.href)
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter(name => name.startsWith('lovbase-offline-') && name !== offlineCache).map(name => caches.delete(name)))
    // Keep bounded, immutable asset entries across versions for tabs still running old code.
    await self.clients.claim()
  })())
})

async function navigation(request) {
  try {
    return await fetch(request)
  } catch {
    return await (await caches.open(offlineCache)).match('/offline.html') || Response.error()
  }
}

async function staticAsset(request, event, pathname) {
  let cache
  try {
    const offline = await (await caches.open(offlineCache)).match(request)
    if (offline) return offline
    cache = await caches.open(assetCache)
    const hit = await cache.match(request)
    if (hit) return hit
  } catch { /* Storage can be disabled or evicted; network use must still work. */ }

  const response = await fetch(request)
  // Only build-listed assets, successful non-HTML responses, and canonical URLs are stored.
  if (cache && assets.has(pathname) && response.ok && !response.redirected
      && !response.headers.get('content-type')?.includes('text/html')
      && !/no-store|private/i.test(response.headers.get('cache-control') || '')) {
    const copy = response.clone()
    event.waitUntil((async () => {
      await cache.put(request, copy)
      const keys = await cache.keys()
      await Promise.all(keys.slice(0, Math.max(0, keys.length - 200)).map(key => cache.delete(key)))
    })().catch(() => {}))
  }
  return response
}

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  // Auth, streaming, RPC, analytics, and MCP must retain their normal network semantics,
  // even if someone navigates directly to an endpoint in the address bar.
  if (/^\/(?:api|ingest|_serverFn|mcp)(?:\/|$)/.test(url.pathname)) return
  if (request.mode === 'navigate' && request.destination === 'document') {
    event.respondWith(navigation(request))
  } else if (!url.search && !request.headers.has('range') && (
    publicFiles.includes(url.pathname) ||
    (url.pathname.startsWith('/assets/') && ['script', 'style', 'font', 'image'].includes(request.destination))
  )) {
    event.respondWith(staticAsset(request, event, url.pathname))
  }
})
