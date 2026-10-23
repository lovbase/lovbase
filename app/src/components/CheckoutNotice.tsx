import { useEffect, useRef } from 'react'
import { useCheckoutSync } from './CheckoutSync'
import type { CheckoutResult } from '../lib/checkout-sync'
import { useT } from '../lib/i18n'
import { Button } from './ui/button'
import { track } from '../lib/posthog'

type CheckoutContext = {
  purchase_type?: 'subscription' | 'credit_pack'
  product?: string
  billing_interval?: 'monthly' | 'yearly'
  source?: string
}

function billingProps(context: CheckoutContext | undefined, result?: CheckoutResult) {
  const purchaseType = result?.kind === 'payment' ? 'credit_pack' : context?.purchase_type ?? 'subscription'
  return {
    purchase_type: purchaseType,
    product: result?.target ?? context?.product,
    ...(purchaseType === 'subscription' && {
      billing_interval: result ? (result.yearly ? 'yearly' : 'monthly') : context?.billing_interval,
    }),
    source: context?.source,
  }
}

/** A Checkout redirect only means the browser returned. The webhook confirms delivery. */
export function CheckoutNotice({ sessionId, canceled, context }: { sessionId?: string; canceled?: boolean; context?: CheckoutContext }) {
  const t = useT()
  const { state, result, retry } = useCheckoutSync(sessionId)
  const returned = useRef<string | null>(null)
  const outcome = useRef<string | null>(null)

  useEffect(() => {
    const key = sessionId ? `session:${sessionId}` : canceled ? `canceled:${context?.purchase_type ?? 'unknown'}` : null
    if (!key || returned.current === key) return
    returned.current = key
    track('billing_checkout_returned', billingProps(context))
    if (canceled) track('billing_checkout_canceled', billingProps(context))
  }, [sessionId, canceled, context])

  useEffect(() => {
    if (!sessionId || !result || result.status === 'pending') return
    const key = `${sessionId}:${result.status}`
    if (outcome.current === key) return
    outcome.current = key
    track(result.status === 'complete' ? 'billing_purchase_completed' : 'billing_purchase_failed', billingProps(context, result))
  }, [sessionId, result, context])
  if (!sessionId && !canceled) return null
  return <output className="block rounded-xl border border-edge p-4 text-[13px] text-fg-mid">
    {!sessionId ? t('billing.canceled', 'Checkout closed. If you did not complete payment, you can try again.')
      : state === 'complete' ? t('billing.complete', 'Payment confirmed. Your account has been updated.')
      : state === 'failed' ? t('billing.failed', 'Payment was not completed. You can try again.')
      : state === 'delayed' ? t('billing.delayed', 'Payment confirmation is taking longer than expected. Refresh to check again.')
      : t('billing.pending', 'Confirming payment…')}
    {sessionId && state === 'delayed' && <Button variant="ghost" onClick={retry}>{t('billing.refresh', 'Refresh')}</Button>}
  </output>
}
