import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { adminForgiveRefundDebt, adminRefunds, adminRetryRefund } from '../functions/admin'
import { useDialogs } from './Dialogs'
import { useI18n } from '../lib/i18n'
import { Button } from './ui/button'

type Overview = Awaited<ReturnType<typeof adminRefunds>>
export function AdminRefunds({ data }: { data: Overview }) {
  const { t } = useI18n()
  const router = useRouter()
  const dialogs = useDialogs()
  const retry = useServerFn(adminRetryRefund)
  const forgive = useServerFn(adminForgiveRefundDebt)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function review(actionKey: string) {
    const reason = await dialogs.prompt({ title: t('refund.review', 'Review and retry'), label: t('refund.reason', 'Review reason') })
    if (!reason?.trim()) return
    if (!await dialogs.confirm({ title: t('refund.confirmRetry', 'Confirm retry after checking the Stripe payment and local ledger?') })) return
    setBusy(true); setError('')
    try { await retry({ data: { actionKey, reason, confirmed: true } }); await router.invalidate() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function forgiveUser(userId: string, email: string, debt: number) {
    const reason = await dialogs.prompt({ title: t('refund.forgive', 'Forgive refund debt'), description: `${email} · ${debt}`, label: t('refund.reason', 'Review reason') })
    if (!reason?.trim()) return
    if (!await dialogs.confirm({ title: t('refund.confirmForgive', 'Confirm forgiving this debt? This creates a separate admin ledger entry.') })) return
    setBusy(true); setError('')
    try { await forgive({ data: { userId, amount: debt, key: crypto.randomUUID(), reason, confirmed: true } }); await router.invalidate() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <section className="rounded-xl border border-edge p-5 space-y-4">
    <h2 className="text-[14px] font-medium">{t('refund.title', 'Refunds and credit reversals')}</h2>
    <p className="text-[12px] text-fg-dim">{t('refund.auditNote', 'Amounts come from Stripe. Historical purchases without verified associations require manual review; original grants are preserved.')}</p>
    {error && <p role="alert" className="text-red-500 text-sm">{error}</p>}
    <div className="overflow-x-auto">
      <table className="w-full min-w-[55rem] text-xs text-left">
        <thead className="text-fg-dim"><tr>
          <th className="py-2">{t('refund.payment', 'Payment / user')}</th><th>{t('refund.amount', 'Refund / cumulative / paid')}</th>
          <th>{t('refund.credits', 'Purchased / revoked / used / debt created')}</th><th>{t('refund.pro', 'Pro revoked')}</th>
        </tr></thead>
        <tbody>{data.refunds.map(r => <tr key={r.stripe_refund_id} className="border-t border-edge/60 align-top">
          <td className="py-3 pr-3"><p>{r.email ?? '—'}</p><p className="break-all text-fg-dim">{r.stripe_refund_id}<br />{r.stripe_charge_id}</p><time>{new Date(r.created_at).toLocaleString()}</time></td>
          <td className="py-3 pr-3 tabular-nums">${(r.amount_cents / 100).toFixed(2)} / ${(r.cumulative_refunded_cents / 100).toFixed(2)} / ${(r.original_amount_cents / 100).toFixed(2)}<br />{Math.floor(r.cumulative_refunded_cents / r.original_amount_cents * 100)}% · {r.status}</td>
          <td className="py-3 pr-3 tabular-nums">{r.purchased_credits ?? '—'} / {r.revoked} / {(r.consumed ?? 0) + (r.debt_settled ?? 0)} / {r.debt_created}</td>
          <td className="py-3 break-all">{r.revoked_subscription ?? '—'}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {data.refunds.length === 0 && <p className="text-xs text-fg-dim">{t('refund.empty', 'No refunds recorded.')}</p>}
    {data.debts.map(d => <div key={d.id} className="flex items-center justify-between gap-3 border-t border-edge pt-3 text-xs">
      <span>{d.email} · {t('refund.debt', 'Outstanding refund debt')}: {d.credit_debt}</span>
      <Button variant="outline" disabled={busy} onClick={() => forgiveUser(d.id, d.email, d.credit_debt)}>{t('refund.forgive', 'Forgive refund debt')}</Button>
    </div>)}
    {data.actions.map(a => <div key={a.action_key} className="border-t border-edge/60 pt-3 text-xs flex items-center justify-between gap-3">
      <div className="min-w-0"><p className="break-all">{a.action_key} · {a.kind} · {a.status} ({a.attempts})</p>
        {a.review_reason && <p className="text-fg-dim">{a.review_reason}</p>}<time className="text-fg-dim">{new Date(a.updated_at).toLocaleString()}</time></div>
      {['manual_review', 'pending'].includes(a.status) && <Button variant="outline" disabled={busy} onClick={() => review(a.action_key)}>{t('refund.review', 'Review and retry')}</Button>}
    </div>)}
    {data.historical.length > 0 && <div className="border-t border-edge pt-3 text-xs space-y-2">
      <p>{t('refund.historical', 'Historical purchases requiring manual association')}</p>
      {data.historical.map(g => <p key={g.id} className="break-all text-fg-dim">{g.email} · #{g.id} · {g.ref ?? '—'} · ${g.amount_usd} · {g.credits}</p>)}
    </div>}
    <details className="border-t border-edge pt-3 text-xs space-y-2">
      <summary className="cursor-pointer">{t('refund.ledger', 'Debt and review audit trail')}</summary>
      {data.ledger.map(e => <p key={e.entry_key} className="break-all text-fg-dim">{e.email ?? e.user_id} · {e.delta > 0 ? '+' : ''}{e.delta} · {e.reason} · {e.actor ?? 'system'} · {new Date(e.created_at).toLocaleString()} · {e.entry_key}</p>)}
      {data.audit.map((e, index) => <p key={`${e.action_key}:${e.created_at}:${index}`} className="break-all text-fg-dim">{e.action_key} · {e.operation} · {e.reason} · {e.actor} · {new Date(e.created_at).toLocaleString()}</p>)}
    </details>
  </section>
}
