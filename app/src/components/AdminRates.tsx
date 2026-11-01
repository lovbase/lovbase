import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import type { ModelRate, Tier } from '@lovbase/core/billing'
import { adminSaveRate } from '../functions'
import { useI18n } from '../lib/i18n'
import { RateEditor } from './RateEditor'

type Item = { model: string; rate: ModelRate; margin: number; fallback: boolean }

/** Admin: what each model in use is charged at, editable in place. */
export function AdminRates({ items, tierOf }: { items: Item[]; tierOf: Record<string, Tier> }) {
  const { t } = useI18n()
  const router = useRouter()
  const save = useServerFn(adminSaveRate)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState('')
  const cols = 'grid grid-cols-[1fr_repeat(3,5.5rem)_8rem_3.5rem] items-center gap-2'
  return (
    <section className="rounded-xl border border-edge overflow-hidden">
      <div className="px-5 py-3 border-b border-edge">
        <h2 className="text-[14px] font-medium">{t('admin.rates.title2', 'Billing rates')}</h2>
        <p className="text-[12.5px] text-fg-dim mt-0.5">{t('admin.rates.sub2', 'USD per million tokens; credits are charged from these. A model with no price is billed at the fallback rate.')}</p>
      </div>
      <div className={`${cols} px-5 py-2 border-b border-edge text-[11.5px] text-fg-dim`}>
        <span>{t('admin.rates.model', 'Model')}</span>
        <span className="text-right">{t('admin.rates.in', 'Input')}</span>
        <span className="text-right">{t('admin.rates.out', 'Output')}</span>
        <span className="text-right">{t('admin.rates.cached', 'Cached input')}</span>
        <span className="text-right">{t('admin.rates.status', 'Status')}</span>
        <span />
      </div>
      <ul className="divide-y divide-edge">
        {items.map((item) => (
          <li key={item.model} className="px-5 py-2.5 text-[12.5px] tabular-nums">
            <div className={cols}>
              <span className="font-mono truncate">{item.model}</span>
              <span className="text-right">${item.rate.inPer1M}</span>
              <span className="text-right">${item.rate.outPer1M}</span>
              <span className="text-right text-fg-mid">{item.rate.cachedInPer1M != null ? `$${item.rate.cachedInPer1M}` : '—'}</span>
              <span className="text-right text-[12px]">
                {item.fallback
                  ? <span className="text-warn" title={t('admin.rates.fallback', 'No configured rate for this model. The fallback rate is being used; verify billing.rates.')}>{t('admin.rates.fallbackShort', 'Fallback price')}</span>
                  : item.rate.cachedInPer1M === undefined
                    ? <span className="text-fg-dim" title={t('admin.rates.noCache', 'No cached-input price configured; cached tokens use the regular input rate.')}>{t('admin.rates.noCacheShort', 'No cache price')}</span>
                    : <span className="text-ok">{t('admin.rates.ok', 'Configured')}</span>}
              </span>
              <button type="button" onClick={() => setEditing(editing === item.model ? null : item.model)} className="text-right text-fg-mid hover:text-fg cursor-pointer">
                {t('admin.price.edit', 'Edit')}
              </button>
            </div>
            {editing === item.model && (
              <div className="mt-2.5 pt-2.5 border-t border-dashed border-edge">
                <RateEditor initial={item.fallback ? undefined : item.rate} saveLabel={t('account.save', 'Save')} onCancel={() => setEditing(null)}
                  onSave={async (p) => {
                    setError('')
                    try { await save({ data: { model: item.model, tier: item.fallback ? tierOf[item.model] : item.rate.tier, ...p } }); setEditing(null); router.invalidate() }
                    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
                  }} />
                {error && <p className="mt-2 text-[12px] text-warn">{error}</p>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
