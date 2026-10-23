export type CheckoutResult = {
  status: 'pending' | 'complete' | 'failed'
  kind?: 'subscription' | 'payment'
  target?: string
  yearly?: boolean
}

export type CheckoutState = 'pending' | 'complete' | 'failed' | 'delayed'

/** Keep confirmation alive across route changes; completion includes refreshing account data. */
export function pollCheckout({ read, refresh, update, interval = 2000, timeout = 30_000 }: {
  read: () => Promise<CheckoutResult>
  refresh: () => Promise<unknown>
  update: (state: CheckoutState, result?: CheckoutResult) => void
  interval?: number
  timeout?: number
}) {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = Date.now() + timeout
  const poll = async () => {
    try {
      const result = await read()
      if (stopped) return
      if (result.status !== 'pending') {
        if (result.status === 'complete') await refresh()
        if (!stopped) update(result.status, result)
        return
      }
    } catch { /* Retry transient status and account refresh failures alike. */ }
    if (stopped) return
    if (Date.now() >= deadline) { update('delayed'); return }
    timer = setTimeout(poll, interval)
  }
  void poll()
  return () => { stopped = true; clearTimeout(timer) }
}
