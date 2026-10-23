import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter, useRouterState } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { paymentStatus } from '../functions/account'
import { pollCheckout, type CheckoutResult, type CheckoutState } from '../lib/checkout-sync'

const storageKey = 'lovbase:pending-checkout:v1'
const validSession = (id: unknown): id is string => typeof id === 'string' && /^cs_[A-Za-z0-9_]{1,252}$/.test(id)
type Snapshot = { id: string; state: CheckoutState; result?: CheckoutResult }
const Context = createContext<{ snapshot?: Snapshot; retry: () => void }>({ retry: () => {} })

/** Lives above the routes so leaving pricing/settings cannot abandon a pending payment. */
export function CheckoutSyncProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const check = useServerFn(paymentStatus)
  const search = useRouterState({ select: state => state.location.searchStr })
  const pathname = useRouterState({ select: state => state.location.pathname })
  const [sessionId, setSessionId] = useState<string>()
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [attempt, setAttempt] = useState(0)
  const seen = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (pathname === '/login' || pathname === '/signup') {
      try { sessionStorage.removeItem(storageKey) } catch { /* Storage is optional. */ }
      // Browser storage must be synchronized after hydration, including on logout.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSessionId(undefined)
      setSnapshot(undefined)
      seen.current = undefined
      return
    }
    const returned = new URLSearchParams(search).get('checkout')
    let pending: string | undefined
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
      if (stored && validSession(stored.id) && Date.now() - stored.at < 30 * 60_000) pending = stored.id
    } catch { /* Missing or unavailable storage never blocks payment confirmation. */ }
    const id = validSession(returned) ? returned : pending
    if (!id || id === seen.current) return
    seen.current = id
    setSnapshot({ id, state: 'pending' })
    setSessionId(id)
    try { sessionStorage.setItem(storageKey, JSON.stringify({ id, at: Date.now() })) } catch { /* Best effort. */ }
  }, [search, pathname])

  useEffect(() => {
    if (!sessionId) return
    return pollCheckout({
      read: () => check({ data: { sessionId } }),
      // Invalidate active and cached loaders, waiting for the visible balance/plan to refresh.
      refresh: () => router.invalidate({ sync: true }),
      update: (state, result) => {
        setSnapshot({ id: sessionId, state, result })
        if (state === 'complete' || state === 'failed') {
          try { sessionStorage.removeItem(storageKey) } catch { /* Best effort. */ }
        }
      },
    })
  }, [sessionId, attempt, check, router])

  const retry = useCallback(() => {
    if (sessionId) setSnapshot({ id: sessionId, state: 'pending' })
    setAttempt(n => n + 1)
  }, [sessionId])
  const value = useMemo(() => ({ snapshot, retry }), [snapshot, retry])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useCheckoutSync(sessionId?: string) {
  const { snapshot, retry } = useContext(Context)
  const current = snapshot && snapshot.id === sessionId ? snapshot : undefined
  return { state: current?.state ?? 'pending', result: current?.result, retry }
}
