import { describe, expect, test } from 'bun:test'
import { completeConnectionPopup, openConnectionPopup } from '../src/lib/connection-popup'

function fakeBrowser(blocked = false) {
  const listeners = new Map<string, (event: unknown) => void>()
  const channels: FakeChannel[] = []
  const posts: unknown[][] = [], storage: unknown[][] = [], opens: unknown[][] = []
  let closes = 0, cleared = 0
  const child = { document: { title: '', body: { textContent: '' } }, location: { href: 'about:blank' }, closed: false, close: () => { closes++; child.closed = true } }
  class FakeChannel {
    listener: ((event: { data: unknown }) => void) | null = null
    closed = false
    constructor(readonly name: string) { channels.push(this) }
    addEventListener(_type: string, listener: (event: { data: unknown }) => void) { this.listener = listener }
    postMessage(data: unknown) { posts.push([data]) }
    close() { this.closed = true }
  }
  const browser = {
    location: { origin: 'https://lovbase.test', search: '', hash: '' },
    screen: { availWidth: 1440, availHeight: 900 }, screenX: 0, screenY: 0, outerWidth: 1440, outerHeight: 900,
    open: (...args: unknown[]) => { opens.push(args); return blocked ? null : child },
    addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener) },
    removeEventListener: (type: string) => { listeners.delete(type) },
    setTimeout: () => 1, clearTimeout: () => { cleared++ },
    BroadcastChannel: FakeChannel,
    opener: { postMessage: (...args: unknown[]) => { posts.push(args) } },
    localStorage: { setItem: (...args: unknown[]) => { storage.push(args) }, removeItem: (...args: unknown[]) => { storage.push(args) } },
    close: () => { closes++ },
  }
  return { browser, window: browser as unknown as typeof window, child, channels, posts, storage, opens, listeners,
    dispatch: (type: string, event: unknown) => listeners.get(type)?.(event), closes: () => closes, cleared: () => cleared }
}

describe('connection authorization popup', () => {
  test('a blocked popup creates no pending listeners or channels', () => {
    const f = fakeBrowser(true)
    expect(openConnectionPopup(() => {}, 'Loading', f.window)).toBeNull()
    expect(f.channels).toHaveLength(0)
    expect(f.listeners.size).toBe(0)
  })

  test('opens a small window immediately and navigates only that window', () => {
    const f = fakeBrowser()
    const popup = openConnectionPopup(() => {}, 'Loading', f.window)!
    expect(f.opens).toHaveLength(1)
    expect(f.opens[0][0]).toBe('about:blank')
    expect(f.opens[0][2]).toContain('popup=yes,width=520,height=720')
    popup.navigate('https://connect.composio.dev/example')
    expect(f.child.location.href).toBe('https://connect.composio.dev/example')
    expect(f.browser.location.origin).toBe('https://lovbase.test')
    popup.close()
    expect(f.listeners.size).toBe(0)
    expect(f.channels[0].closed).toBe(true)
    expect(f.cleared()).toBe(1)
  })

  test('ignores unrelated origins, windows, attempts and invalid results; completes once', () => {
    const f = fakeBrowser(), results: string[] = []
    const popup = openConnectionPopup(result => results.push(result), 'Loading', f.window)!
    const requestId = new URL(popup.returnPath, f.browser.location.origin).searchParams.get('requestId')
    const data = { type: 'lovbase:connection-auth-result', requestId, result: 'connected' }
    f.dispatch('message', { origin: 'https://evil.test', source: f.child, data })
    f.dispatch('message', { origin: f.browser.location.origin, source: {}, data })
    f.dispatch('message', { origin: f.browser.location.origin, source: f.child, data: { ...data, requestId: 'another-attempt' } })
    f.channels[0].listener?.({ data: { ...data, result: 'unexpected' } })
    expect(results).toEqual([])
    const receive = f.channels[0].listener!
    receive({ data })
    receive({ data })
    expect(results).toEqual(['connected'])
    expect(f.closes()).toBe(1)
    expect(f.listeners.size).toBe(0)
  })

  test('receives an isolated provider callback even when COOP makes the popup appear closed', () => {
    const f = fakeBrowser(), results: string[] = []
    const popup = openConnectionPopup(result => results.push(result), 'Loading', f.window)!
    const requestId = new URL(popup.returnPath, f.browser.location.origin).searchParams.get('requestId')
    f.child.closed = true
    f.channels[0].listener?.({ data: { type: 'lovbase:connection-auth-result', requestId, result: 'identity_changed' } })
    expect(results).toEqual(['identity_changed'])
  })

  test('publishes cancellation to the original origin and removes the temporary storage receipt', () => {
    const f = fakeBrowser()
    f.browser.location.search = '?requestId=00000000-0000-4000-8000-000000000000'
    f.browser.location.hash = '#connections=failed&view=dialog'
    expect(completeConnectionPopup(f.window)).toBe('failed')
    expect(f.posts[0][1]).toBe('https://lovbase.test')
    expect(f.storage).toHaveLength(2)
    expect(f.storage[0][0]).toBe(f.storage[1][0])
    expect(f.channels[0].closed).toBe(true)
    expect(f.closes()).toBe(1)
  })

  test('rejects a callback without a valid attempt id or outcome', () => {
    const f = fakeBrowser()
    f.browser.location.search = '?requestId=unrelated'
    f.browser.location.hash = '#connections=connected'
    expect(completeConnectionPopup(f.window)).toBeNull()
    expect(f.posts).toEqual([])
    expect(f.closes()).toBe(0)
  })
})
