import { useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { paymentStatus } from '../functions/account'
import { useT } from '../lib/i18n'
import { Button } from './ui/button'

/** A Checkout redirect only means the browser returned. The webhook confirms delivery. */
export function CheckoutNotice({ sessionId, canceled }: { sessionId?: string; canceled?: boolean }) {
  const t = useT()
  const router = useRouter()
  const check = useServerFn(paymentStatus)
  const [state, setState] = useState<'pending' | 'complete' | 'failed' | 'delayed'>('pending')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!sessionId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const deadline = Date.now() + 30_000
    const poll = async () => {
      try {
        const result = await check({ data: { sessionId } })
        if (stopped) return
        if (result.status !== 'pending') {
          setState(result.status)
          if (result.status === 'complete') await router.invalidate()
          return
        }
      } catch { /* A transient request failure is not a failed payment. Allow a manual retry. */ }
      if (stopped) return
      if (Date.now() >= deadline) { setState('delayed'); return }
      timer = setTimeout(poll, 2000)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [sessionId, attempt, check, router])
  if (!sessionId && !canceled) return null
  return <output className="block rounded-xl border border-edge p-4 text-[13px] text-fg-mid">
    {!sessionId ? t('billing.canceled', 'Checkout closed. If you did not complete payment, you can try again.')
      : state === 'complete' ? t('billing.complete', 'Payment confirmed. Your account has been updated.')
      : state === 'failed' ? t('billing.failed', 'Payment was not completed. You can try again.')
      : state === 'delayed' ? t('billing.delayed', 'Payment confirmation is taking longer than expected. Refresh to check again.')
      : t('billing.pending', 'Confirming payment…')}
    {sessionId && state === 'delayed' && <Button variant="ghost" onClick={() => { setState('pending'); setAttempt(n => n + 1) }}>{t('billing.refresh', 'Refresh')}</Button>}
  </output>
}
