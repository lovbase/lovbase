import { expect, test } from 'bun:test'
import { pollCheckout, type CheckoutResult, type CheckoutState } from '../src/lib/checkout-sync'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('confirmation waits for fresh account loaders before reporting success', async () => {
  const refreshed = deferred<void>()
  const refreshing = deferred<void>()
  const finished = deferred<CheckoutState>()
  let reads = 0, completed = false
  const stop = pollCheckout({
    read: async () => ({ status: ++reads === 1 ? 'pending' : 'complete' }),
    refresh: () => { refreshing.resolve(); return refreshed.promise },
    update: state => { completed = true; finished.resolve(state) },
    interval: 1,
  })
  try {
    await refreshing.promise
    expect(completed).toBe(false)
    refreshed.resolve()
    expect(await finished.promise).toBe('complete')
    expect(reads).toBe(2)
  } finally { stop() }
})

test('a temporary account refresh failure is retried instead of leaving stale credits', async () => {
  const finished = deferred<CheckoutState>()
  let refreshes = 0
  const stop = pollCheckout({
    read: async () => ({ status: 'complete' }),
    refresh: async () => { if (++refreshes === 1) throw Error('Temporary loader failure') },
    update: state => finished.resolve(state),
    interval: 1,
  })
  try {
    expect(await finished.promise).toBe('complete')
    expect(refreshes).toBe(2)
  } finally { stop() }
})

test('failed payment never refreshes or reports granted credits', async () => {
  const finished = deferred<CheckoutState>()
  let refreshes = 0
  const stop = pollCheckout({
    read: async () => ({ status: 'failed' }),
    refresh: async () => { refreshes++ },
    update: state => finished.resolve(state),
  })
  try {
    expect(await finished.promise).toBe('failed')
    expect(refreshes).toBe(0)
  } finally { stop() }
})

test('an abandoned monitor cannot publish an old account result', async () => {
  const response = deferred<CheckoutResult>()
  let refreshes = 0, updates = 0
  const stop = pollCheckout({
    read: () => response.promise,
    refresh: async () => { refreshes++ },
    update: () => { updates++ },
  })
  stop()
  response.resolve({ status: 'complete' })
  await response.promise
  expect(refreshes).toBe(0)
  expect(updates).toBe(0)
})

test('missing confirmation times out without assuming the payment succeeded', async () => {
  const finished = deferred<CheckoutState>()
  const stop = pollCheckout({
    read: async () => { throw Error('Temporary network failure') },
    refresh: async () => { throw Error('Must not be called') },
    update: state => finished.resolve(state),
    timeout: 0,
  })
  try { expect(await finished.promise).toBe('delayed') } finally { stop() }
})
