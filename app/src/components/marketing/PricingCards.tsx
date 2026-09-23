import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { requestUpgrade } from '../../functions/account'
import { Check } from 'lucide-react'
import { PLANS, PLAN_IDS, type PlanSpec } from '@lovbase/core/plans'
import { useT } from '../../lib/i18n'

export type Billing = 'monthly' | 'yearly'

export const priceOf = (p: PlanSpec, billing: Billing) => (billing === 'yearly' ? p.yearlyPrice : p.price)

/** 5 GB reads better than 5000 MB. */
export function fmtStorage(mb: number) {
  return mb >= 1000 ? `${Math.round(mb / 100) / 10} GB` : `${mb} MB`
}

/** Yearly discount, derived from plans.ts so the number can never drift from the price. */
export function yearlySavingPct() {
  const p = PLANS.pro
  if (!p.price) return 0
  return Math.round((1 - p.yearlyPrice / p.price) * 100)
}

export function BillingToggle({ value, onChange }: { value: Billing; onChange: (b: Billing) => void }) {
  const t = useT()
  const pct = yearlySavingPct()
  return (
    <div className="inline-flex items-center gap-3">
      <div role="tablist" aria-label={t('pricing.aria.billing', 'Billing period')} className="inline-flex p-1 rounded-xl border border-edge bg-panel-2">
        {(['monthly', 'yearly'] as const).map((b) => (
          <button key={b} type="button" role="tab" aria-selected={value === b} onClick={() => onChange(b)}
            className={`px-3.5 py-1.5 rounded-lg text-[13px] font-medium transition-colors cursor-pointer ${
              value === b ? 'bg-panel text-fg shadow-sm border border-edge' : 'text-fg-mid hover:text-fg border border-transparent'
            }`}>
            {b === 'monthly' ? t('pricing.billing.monthly', 'Monthly') : t('pricing.billing.yearly', 'Yearly')}
          </button>
        ))}
      </div>
      {pct > 0 && <span className="text-[12.5px] text-fg-dim">{t('pricing.billing.save', 'Save {pct}% yearly').replace('{pct}', String(pct))}</span>}
    </div>
  )
}

export type Viewer = { signedIn: boolean; plan: string | null }

export function PlanCards({ billing, compact = false, viewer }: { billing: Billing; compact?: boolean; viewer?: Viewer }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
      {PLAN_IDS.map((id) => <PlanCard key={id} plan={PLANS[id]} billing={billing} compact={compact} viewer={viewer} />)}
    </div>
  )
}

function PlanCard({ plan, billing, compact, viewer }: { plan: PlanSpec; billing: Billing; compact: boolean; viewer?: Viewer }) {
  const t = useT()
  const upgrade = useServerFn(requestUpgrade)
  const [asked, setAsked] = useState(false)
  const price = priceOf(plan, billing)
  // plans.ts is the English source; other locales key each line by plan id and position.
  const tagline = t(`plan.${plan.id}.tagline`, plan.tagline)
  const all = plan.features.map((f, i) => t(`plan.${plan.id}.feature.${i}`, f))
  const features = compact ? all.slice(0, 3) : all
  const featured = !!plan.featured

  return (
    <div className={`relative rounded-2xl border bg-panel p-6 flex flex-col h-full transition-colors ${
      featured ? 'border-edge-strong shadow-[0_1px_2px_rgba(0,0,0,.04),0_18px_40px_-26px_rgba(0,0,0,.35)] dark:shadow-[0_18px_40px_-26px_rgba(0,0,0,.9)]' : 'border-edge'
    }`}>
      {featured && (
        <span className="absolute -top-2.5 left-6 px-2 py-0.5 rounded-full bg-accent text-on-accent text-[11px] font-medium">
          {t('pricing.card.popular', 'Most popular')}
        </span>
      )}

      <div className="flex items-baseline justify-between">
        <h3 className="font-display text-[17px] font-semibold">{plan.name}</h3>
        <span className="font-mono text-[11px] text-fg-dim">{t('pricing.card.creditsPerMonth', '{n} credits / mo').replace('{n}', String(plan.credits))}</span>
      </div>
      <p className="text-[13px] text-fg-dim mt-1.5">{tagline}</p>

      <div className="mt-5 flex items-end gap-1.5">
        <span className="font-display text-[38px] font-semibold leading-none tracking-tight">${price}</span>
        <span className="text-[13px] text-fg-dim pb-1">{t('pricing.card.perMonth', '/ mo')}</span>
      </div>
      <p className="text-[12px] text-fg-dim mt-1.5 h-4">
        {price === 0
          ? t('pricing.card.freeForever', 'Free forever, no credit card')
          : billing === 'yearly'
            ? t('pricing.card.billedYearly', 'Billed yearly at ${total}').replace('{total}', String(price * 12))
            : t('pricing.card.billedMonthly', 'Billed monthly, cancel anytime')}
      </p>

      {/* Signed out, every button is the signup form. Signed in, the free card is a door back to
          the workspace, the current plan says so, and any other plan records the interest here —
          nothing can take money yet, and sending someone who is already logged in to /signup
          looked like the click had simply failed. */}
      {(() => {
        const cls = `mt-5 inline-flex items-center justify-center py-2.5 rounded-lg text-[13.5px] font-medium transition-colors ${
          featured ? 'bg-accent text-on-accent hover:bg-accent-soft' : 'border border-edge text-fg-mid hover:text-fg hover:border-edge-strong'}`
        if (!viewer?.signedIn) {
          return <Link to="/signup" className={cls}>{plan.id === 'free' ? t('cta.startFree', 'Start free') : `${t('pricing.card.choose', 'Choose')} ${plan.name}`}</Link>
        }
        if (plan.id === viewer.plan) {
          return <span className={`${cls} border border-edge text-fg-dim cursor-default`}>{t('pricing.card.current', 'Current plan')}</span>
        }
        if (plan.id === 'free') return <Link to="/home" className={cls}>{t('nav.workspace', 'Open workspace')}</Link>
        return (
          <button type="button" disabled={asked} className={`${cls} cursor-pointer disabled:opacity-70 disabled:cursor-default`}
            onClick={() => upgrade({ data: { kind: 'plan', target: plan.id, source: 'pricing' } }).then(() => setAsked(true))}>
            {asked ? t('pricing.card.asked', 'Noted, we will be in touch') : `${t('pricing.card.choose', 'Choose')} ${plan.name}`}
          </button>
        )
      })()}

      <ul className="mt-6 space-y-2.5 flex-1">
        {features.map((f) => (
          <li key={f} className="flex gap-2.5 text-[13px] text-fg-mid leading-relaxed">
            <Check className="size-3.5 mt-[3px] shrink-0 text-fg-dim" strokeWidth={2.5} />
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
