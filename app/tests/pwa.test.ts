import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { applyPwaUpdate } from '../src/lib/pwa'

const origin = 'https://lovbase.test'
const source = readFileSync(new URL('../pwa/sw.js', import.meta.url), 'utf8')
const assetPaths = Array.from({ length: 205 }, (_, i) => `/assets/chunk-${i}.js`)

function workerHarness() {
  const listeners = new Map<string, (event: any) => void>()
  const stores = new Map<string, Map<string, Response>>()
  let calls = 0
  let skipWaiting = 0
  let claimed = 0
  let offline = false
  let status = 200
  let type = 'text/javascript'
  let storageFails = false
  const opened: string[] = [], focused: string[] = []
  const windows: { url: string; focus: () => Promise<void> }[] = []
  const key = (input: string | Request) => new URL(typeof input === 'string' ? input : input.url, origin).href
  const caches = {
    async open(name: string) {
      if (storageFails) throw new Error('Storage disabled')
      if (!stores.has(name)) stores.set(name, new Map())
      const entries = stores.get(name)!
      return {
        async addAll(inputs: Request[]) { for (const input of inputs) entries.set(key(input), new Response('offline page')) },
        async match(input: string | Request) { return entries.get(key(input))?.clone() },
        async put(input: Request, response: Response) { entries.set(key(input), response.clone()) },
        async keys() { return [...entries.keys()].map(url => new Request(url)) },
        async delete(input: Request) { return entries.delete(key(input)) },
      }
    },
    async keys() { return [...stores.keys()] },
    async delete(name: string) { return stores.delete(name) },
  }
  runInNewContext(source
    .replace('__PWA_VERSION__', 'test')
    .replace('__PWA_PUBLIC_FILES__', JSON.stringify(['/offline.html', '/favicon.svg']))
    .replace('__PWA_ASSETS__', JSON.stringify(assetPaths)), {
    self: {
      location: { origin },
      addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
      skipWaiting: async () => { skipWaiting++ },
      clients: { claim: async () => { claimed++ }, matchAll: async () => windows,
        openWindow: async (url: string) => { opened.push(url) } },
    },
    caches, URL, Response,
    Request: class extends Request {
      constructor(input: string, options: RequestInit) { super(new URL(input, origin), options) }
    },
    fetch: async () => {
      calls++
      if (offline) throw new Error('Network unavailable')
      return new Response('network response', { status, headers: { 'content-type': type } })
    },
  })
  const dispatch = async (name: string, properties = {}) => {
    const pending: Promise<unknown>[] = []
    let response: Promise<Response> | undefined
    listeners.get(name)?.({ ...properties, waitUntil: (p: Promise<unknown>) => pending.push(p), respondWith: (p: Promise<Response>) => { response = p } })
    const result = await response
    await Promise.all(pending)
    return result
  }
  return {
    stores, dispatch, opened, focused,
    addWindow: (url: string) => windows.push({url,focus:async()=>{focused.push(url)}}),
    calls: () => calls,
    skips: () => skipWaiting,
    claims: () => claimed,
    offline: () => { offline = true },
    storageFails: () => { storageFails = true },
    response: (code: number, mime: string) => { status = code; type = mime },
    request: (path: string, overrides = {}) => dispatch('fetch', { request: {
      url: new URL(path, origin).href, method: 'GET', mode: 'cors', destination: 'script', headers: new Headers(), ...overrides,
    } }),
  }
}

describe('PWA service worker', () => {
  test('notification clicks open the correct app or focus its existing tab, and reject external destinations', async () => {
    const w = workerHarness(), url = `${origin}/projects/p1?app=a1`
    let closed = 0
    const notification = (destination: string) => ({ data:{url:destination},close:()=>{closed++} })
    await w.dispatch('notificationclick',{notification:notification(url)})
    expect(w.opened).toEqual([url])
    w.addWindow(url)
    await w.dispatch('notificationclick',{notification:notification(url)})
    expect(w.focused).toEqual([url])
    await w.dispatch('notificationclick',{notification:notification('https://external.invalid/projects/p1')})
    expect(w.opened).toHaveLength(1)
    expect(closed).toBe(3)
  })
  test('install waits for consent; activation only deletes obsolete offline caches', async () => {
    const w = workerHarness()
    w.stores.set('other-app-cache', new Map())
    w.stores.set('lovbase-offline-old', new Map())
    w.stores.set('lovbase-assets-v1', new Map())
    await w.dispatch('install')
    expect(w.skips()).toBe(0)
    await w.dispatch('message', { data: { type: 'SKIP_WAITING' } })
    expect(w.skips()).toBe(1)
    await w.dispatch('activate')
    expect([...w.stores.keys()].toSorted()).toEqual(['lovbase-assets-v1', 'lovbase-offline-test', 'other-app-cache'])
    expect(w.claims()).toBe(1)
  })

  test('document navigation uses the network, falls back offline, and never stores private HTML', async () => {
    const w = workerHarness()
    await w.dispatch('install')
    const navigation = { mode: 'navigate', destination: 'document' }
    expect(await (await w.request('/projects/private', navigation))?.text()).toBe('network response')
    w.offline()
    expect(await (await w.request('/projects/private', navigation))?.text()).toBe('offline page')
    expect(Array.from(w.stores.values()).some(store => Array.from(store.keys()).some(url => url.includes('private')))).toBe(false)
  })

  test('server errors are not disguised as offline pages', async () => {
    const w = workerHarness()
    w.response(503, 'text/html')
    expect((await w.request('/home', { mode: 'navigate', destination: 'document' }))?.status).toBe(503)
  })

  test('auth, RPC, streams, POST, cross-origin previews and iframes bypass the worker', async () => {
    const w = workerHarness()
    for (const path of ['/api/auth/session', '/api/chat', '/_serverFn/abc', '/ingest/event', '/mcp']) {
      expect(await w.request(path, { mode: 'navigate', destination: 'document' })).toBeUndefined()
    }
    expect(await w.request('/home', { method: 'POST' })).toBeUndefined()
    expect(await w.request('https://sandbox.test/assets/chunk-0.js')).toBeUndefined()
    expect(await w.request('/preview', { mode: 'navigate', destination: 'iframe' })).toBeUndefined()
    expect(w.calls()).toBe(0)
  })

  test('build assets can be read offline after first use', async () => {
    const w = workerHarness()
    await w.request(assetPaths[0])
    w.offline()
    expect(await (await w.request(assetPaths[0]))?.text()).toBe('network response')
    expect(w.calls()).toBe(1)
  })

  test('unlisted assets, HTML errors, failures and query URLs do not populate the asset cache', async () => {
    const w = workerHarness()
    await w.request('/assets/unknown.js')
    w.response(200, 'text/html')
    await w.request(assetPaths[0])
    w.response(404, 'text/javascript')
    await w.request(assetPaths[1])
    expect(await w.request(`${assetPaths[0]}?token=private`)).toBeUndefined()
    expect(w.stores.get('lovbase-assets-v1')?.size).toBe(0)
  })

  test('cache storage failure does not break network requests', async () => {
    const w = workerHarness()
    w.storageFails()
    expect(await (await w.request(assetPaths[0]))?.text()).toBe('network response')
  })

  test('static asset storage stays bounded across releases', async () => {
    const w = workerHarness()
    for (const path of assetPaths) await w.request(path)
    expect(w.stores.get('lovbase-assets-v1')?.size).toBe(200)
    expect(w.stores.get('lovbase-assets-v1')?.has(`${origin}${assetPaths[0]}`)).toBe(false)
  })
})

test('accepting an update waits for activation and reloads only the requesting window once', () => {
  const worker = new EventTarget() as ServiceWorker
  let state = 'installed'
  let message: unknown
  let reloads = 0
  Object.defineProperty(worker, 'state', { get: () => state })
  worker.postMessage = value => { message = value }
  applyPwaUpdate(worker, { location: { reload: () => { reloads++ } } } as unknown as Window)
  expect(message).toEqual({ type: 'SKIP_WAITING' })
  expect(reloads).toBe(0)
  state = 'activated'
  worker.dispatchEvent(new Event('statechange'))
  worker.dispatchEvent(new Event('statechange'))
  expect(reloads).toBe(1)
})
