import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '../lib/i18n'

export type Price = { inPer1M: number; outPer1M: number; cachedInPer1M?: number }

/** Three prices in USD per million tokens, the unit provider price pages use. */
export function RateEditor({ initial, onSave, onCancel, saveLabel }: {
  initial?: Partial<Price>
  onSave: (p: Price) => void | Promise<void>
  onCancel: () => void
  saveLabel?: string
}) {
  const { t } = useI18n()
  const [v, setV] = useState({
    in: initial?.inPer1M?.toString() ?? '',
    out: initial?.outPer1M?.toString() ?? '',
    cached: initial?.cachedInPer1M?.toString() ?? '',
  })
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s))
  const valid = [v.in, v.out].every((s) => s.trim() !== '' && Number(s) >= 0) && (v.cached.trim() === '' || Number(v.cached) >= 0)
  const field = (key: keyof typeof v, label: string, placeholder: string) => (
    <label className="flex items-center gap-1.5">
      <span className="text-[12px] text-fg-dim whitespace-nowrap">{label}</span>
      <span className="relative">
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[12.5px] text-fg-dim">$</span>
        <Input inputMode="decimal" value={v[key]} placeholder={placeholder} onChange={(e) => setV({ ...v, [key]: e.target.value })}
          className="h-8 w-20 pl-5 text-[12.5px] tabular-nums" />
      </span>
    </label>
  )
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {field('in', t('admin.rates.in', 'Input'), '3')}
      {field('out', t('admin.rates.out', 'Output'), '15')}
      {field('cached', t('admin.rates.cached', 'Cached input'), '0.3')}
      <span className="text-[12px] text-fg-dim">/ 1M tokens</span>
      <span className="flex gap-1.5 ml-auto">
        <Button size="sm" variant="ghost" onClick={onCancel}>{t('dialog.cancel', 'Cancel')}</Button>
        <Button size="sm" disabled={!valid} onClick={() => onSave({ inPer1M: Number(v.in), outPer1M: Number(v.out), cachedInPer1M: num(v.cached) })}>
          {saveLabel ?? t('admin.rates.apply', 'Apply')}
        </Button>
      </span>
    </div>
  )
}

export const fmtPrice = (p: Partial<Price>, cachedLabel: string) =>
  `$${p.inPer1M} / $${p.outPer1M}${p.cachedInPer1M != null ? ` · ${cachedLabel} $${p.cachedInPer1M}` : ''}`
