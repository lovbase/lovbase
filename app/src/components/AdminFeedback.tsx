import { useEffect, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import type { FeedbackRow } from '@lovbase/api'
import type { FeedbackStatus } from '@lovbase/core/feedback'
import { adminFeedback, adminFeedbackStatus } from '../functions/feedback'
import { useI18n } from '../lib/i18n'
import { Button } from './ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

export function AdminFeedback() {
  const { t, locale } = useI18n()
  const list = useServerFn(adminFeedback), update = useServerFn(adminFeedbackStatus)
  const [status, setStatus] = useState<FeedbackStatus | ''>('')
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0)
  const [data, setData] = useState<{ rows: FeedbackRow[]; hasMore: boolean } | null>(null)
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState<string | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    void list({ data: { status: status || undefined, offset } }).then(value => { if (alive) setData(value) })
      .catch(() => { if (alive) setError(t('feedback.loadFailed', 'Could not load feedback. Please try again.')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [list, status, offset, revision])
  const statusLabel = (value: FeedbackStatus) => value === 'new' ? t('feedback.new', 'New') : value === 'reviewing' ? t('feedback.reviewing', 'Reviewing') : t('feedback.resolved', 'Resolved')
  return <section className="rounded-xl border border-edge overflow-hidden">
    <div className="flex flex-wrap items-center gap-3 border-b border-edge px-5 py-3">
      <h2 className="mr-auto text-sm font-medium">{t('feedback.adminTitle', 'Customer feedback')}</h2>
      <Select value={status} onValueChange={value => { if (value !== null) { setStatus(value); setOffset(0) } }}>
        <SelectTrigger aria-label={t('feedback.filter', 'Filter by status')} className="border-edge bg-panel text-xs">
          <SelectValue>{value => value ? statusLabel(value as FeedbackStatus) : t('feedback.all', 'All statuses')}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">{t('feedback.all', 'All statuses')}</SelectItem>
          {(['new','reviewing','resolved'] as const).map(value => <SelectItem key={value} value={value}>{statusLabel(value)}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button size="sm" variant="ghost" disabled={loading} onClick={() => setRevision(value => value + 1)}>{t('feedback.refresh', 'Refresh')}</Button>
    </div>
    <div className="divide-y divide-edge" aria-busy={loading}>
      {error && <p role="alert" className="p-5 text-xs text-red-600">{error}</p>}
      {loading ? <p role="status" className="p-5 text-sm text-fg-dim">{t('feedback.loading', 'Loading feedback…')}</p> : !error && <>
        {!data?.rows.length && <p className="p-5 text-sm text-fg-dim">{t('feedback.empty', 'No feedback yet.')}</p>}
        {data?.rows.map(row => <article key={row.id} className="space-y-3 p-5 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">{row.name || row.email || t('admin.deletedAccount', '(Deleted account)')}</span>
            {row.name && <span className="text-xs text-fg-dim">{row.email}</span>}
            <span className="rounded-md bg-panel-2 px-2 py-1 text-xs">{row.kind === 'suggestion' ? t('feedback.suggestion', 'Suggestion') : row.kind === 'bug' ? t('feedback.bug', 'Problem') : t('feedback.other', 'Other')}</span>
            <time className="text-xs text-fg-dim">{new Date(row.created_at).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en')}</time>
            <Select value={row.status} disabled={saving !== null} onValueChange={async next => {
              if (next === null) return
              setSaving(row.id); setError('')
              try { await update({ data: { id: row.id, status: next } }); setRevision(value => value + 1) }
              catch { setError(t('feedback.updateFailed', 'Could not update status. Please try again.')) }
              finally { setSaving(null) }
            }}>
              <SelectTrigger aria-label={t('feedback.status', 'Status')} className="ml-auto border-edge bg-panel text-xs">
                <SelectValue>{value => statusLabel(value as FeedbackStatus)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(['new','reviewing','resolved'] as const).map(value => <SelectItem key={value} value={value}>{statusLabel(value)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <p className="whitespace-pre-wrap break-words">{row.message}</p>
          <div className="flex flex-wrap gap-3 text-xs text-fg-dim">
            <span>{row.page}</span>
            {row.project_id && <span>{row.project_name || row.project_id} ({row.project_id})</span>}
          </div>
          {!!row.screenshots.length && <div className="flex flex-wrap gap-3">{row.screenshots.map(image => {
            const url = `/api/feedback/${encodeURIComponent(row.id)}/images/${image.position}`
            return <a key={image.position} href={url} target="_blank" rel="noreferrer"><img loading="lazy" src={url} alt={image.name} className="h-24 max-w-40 rounded-lg border border-edge object-contain" /></a>
          })}</div>}
        </article>)}
      </>}
    </div>
    <div className="flex items-center justify-end gap-3 border-t border-edge px-5 py-3">
      <Button size="sm" variant="ghost" disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0,value-20))}>{t('feedback.previous', 'Previous')}</Button>
      <span className="text-xs text-fg-dim">{offset / 20 + 1}</span>
      <Button size="sm" variant="ghost" disabled={loading || !data?.hasMore} onClick={() => setOffset(value => value+20)}>{t('feedback.next', 'Next')}</Button>
    </div>
  </section>
}
