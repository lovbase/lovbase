import { describe, expect, test } from 'bun:test'
import { chunkRecoveryScript, installChunkRecovery } from '../src/lib/chunk-recovery'

function fakeBrowser(initialMarker?: string) {
  let listener: ((event: Event) => void) | undefined
  let reloads = 0
  const values = new Map<string, string>()
  if (initialMarker) values.set('lovbase:chunk-reload', initialMarker)

  const browser = {
    addEventListener: (type: string, next: (event: Event) => void) => {
      if (type === 'vite:preloadError') listener = next
    },
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    location: { reload: () => { reloads += 1 } },
  } as unknown as Window

  return {
    browser,
    dispatch: () => {
      let prevented = false
      listener?.({ preventDefault: () => { prevented = true } } as Event)
      return prevented
    },
    reloads: () => reloads,
  }
}

function browserWithoutStorage() {
  let listener: ((event: Event) => void) | undefined
  let reloads = 0
  return {
    browser: {
      addEventListener: (_type: string, next: (event: Event) => void) => { listener = next },
      sessionStorage: {
        getItem: () => { throw new Error('storage disabled') },
      },
      location: { reload: () => { reloads += 1 } },
    } as unknown as Window,
    dispatch: () => {
      let prevented = false
      listener?.({ preventDefault: () => { prevented = true } } as Event)
      return prevented
    },
    reloads: () => reloads,
  }
}

describe('chunk recovery', () => {
  test('reloads once when a stale Vite chunk fails', () => {
    const fake = fakeBrowser()
    installChunkRecovery(fake.browser)

    expect(fake.dispatch()).toBe(true)
    expect(fake.reloads()).toBe(1)
  })

  test('does not hide or loop on a repeated failure', () => {
    const fake = fakeBrowser(String(Date.now()))
    installChunkRecovery(fake.browser)

    expect(fake.dispatch()).toBe(false)
    expect(fake.reloads()).toBe(0)
  })

  test('does not risk a loop when session storage is unavailable', () => {
    const fake = browserWithoutStorage()
    installChunkRecovery(fake.browser)

    expect(fake.dispatch()).toBe(false)
    expect(fake.reloads()).toBe(0)
  })

  test('the inline bootstrap is standalone', () => {
    const fake = fakeBrowser()
    Function('window', chunkRecoveryScript)(fake.browser)

    expect(fake.dispatch()).toBe(true)
    expect(fake.reloads()).toBe(1)
  })
})
