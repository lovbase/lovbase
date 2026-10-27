import { useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Check, Loader2, MessageSquare, X } from 'lucide-react'
import { FEEDBACK_IMAGE_BYTES, FEEDBACK_IMAGE_COUNT, type FeedbackInput } from '@lovbase/core/feedback'
import { submitFeedback } from '../functions/feedback'
import { useT } from '../lib/i18n'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

const asDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.addEventListener('load', () => resolve(String(reader.result)), { once: true })
  reader.addEventListener('error', () => reject(new Error('Could not read screenshot')), { once: true })
  reader.readAsDataURL(file)
})

export function FeedbackDialog({ open, onOpenChange, projectId }: {
  open: boolean; onOpenChange: (open: boolean) => void; projectId?: string
}) {
  const t = useT(), submit = useServerFn(submitFeedback)
  const [id, setId] = useState('')
  const [kind, setKind] = useState<FeedbackInput['kind']>('suggestion')
  const [message, setMessage] = useState('')
  const [screenshots, setScreenshots] = useState<FeedbackInput['screenshots']>([])
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(false)
  const [error, setError] = useState(''), [sent, setSent] = useState(false)

  async function attach(files: File[]) {
    setError('')
    if (screenshots.length + files.length > FEEDBACK_IMAGE_COUNT) {
      setError(t('feedback.imageLimit', 'Add up to 3 PNG, JPEG or WebP screenshots, 2 MB each.')); return
    }
    if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > FEEDBACK_IMAGE_BYTES || !file.size)) {
      setError(t('feedback.imageLimit', 'Add up to 3 PNG, JPEG or WebP screenshots, 2 MB each.')); return
    }
    setReading(true)
    try {
      const images = await Promise.all(files.map(async file => ({ name: file.name.slice(0,150), dataUrl: await asDataUrl(file) })))
      setScreenshots(current => [...current, ...images])
    }
    catch { setError(t('feedback.readFailed', 'Could not read screenshot. Please try again.')) }
    finally { setReading(false) }
  }

  return <Dialog open={open} onOpenChange={value => {
    if (busy || reading) return
    if (!value) setSent(false)
    onOpenChange(value)
  }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto bg-panel text-fg sm:max-w-lg">
      <DialogTitle className="flex items-center gap-2 pr-8"><MessageSquare className="size-4" />{t('feedback.title', 'Feedback')}</DialogTitle>
      <DialogDescription>{t('feedback.description', 'Share a suggestion or report a problem. Your account and the current page are included so we can investigate.')}</DialogDescription>
      {sent ? <div className="space-y-4 py-3">
        <output className="flex items-center gap-2 text-sm"><Check className="size-4 text-emerald-600" />{t('feedback.sent', 'Feedback submitted. Thank you!')}</output>
        <Button onClick={() => { onOpenChange(false); setSent(false) }}>{t('feedback.close', 'Close')}</Button>
      </div> : <form className="space-y-4" onSubmit={async event => {
        event.preventDefault(); if (busy || reading || !message.trim()) return
        setBusy(true); setError('')
        const requestId = id || crypto.randomUUID()
        setId(requestId)
        try {
          await submit({ data: { id: requestId, kind, message, screenshots, projectId, page: window.location.pathname.slice(0,500) } })
          setSent(true); setMessage(''); setScreenshots([]); setId(crypto.randomUUID())
        } catch { setError(t('feedback.submitFailed', 'Could not submit feedback. Your draft is kept; please try again.')) }
        finally { setBusy(false) }
      }}>
        <label className="block space-y-2 text-sm">
          <span>{t('feedback.kind', 'Type')}</span>
          <Select value={kind} disabled={busy} onValueChange={value => { if (value !== null) setKind(value) }}>
            <SelectTrigger aria-label={t('feedback.kind', 'Type')} className="w-full border-edge bg-panel">
              <SelectValue>{value => value === 'suggestion' ? t('feedback.suggestion', 'Suggestion') : value === 'bug' ? t('feedback.bug', 'Problem') : t('feedback.other', 'Other')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="suggestion">{t('feedback.suggestion', 'Suggestion')}</SelectItem>
              <SelectItem value="bug">{t('feedback.bug', 'Problem')}</SelectItem>
              <SelectItem value="other">{t('feedback.other', 'Other')}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="block space-y-2 text-sm">
          <span>{t('feedback.message', 'Details')}</span>
          <textarea required maxLength={5000} rows={5} value={message} disabled={busy} onChange={event => setMessage(event.target.value)}
            placeholder={t('feedback.placeholder', 'What would you like to improve? For a problem, describe what you did and what happened.')}
            className="w-full resize-y rounded-lg border border-edge bg-panel p-3 outline-none focus:border-edge-strong" />
          <span className="block text-right text-xs text-fg-dim">{message.length}/5000</span>
        </label>
        <label className="block space-y-2 text-xs text-fg-mid">
          <span>{t('feedback.screenshots', 'Screenshots (optional)')}</span>
          <input type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={busy || reading || screenshots.length >= FEEDBACK_IMAGE_COUNT}
            onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void attach(files) }} className="block w-full text-xs file:mr-3 file:rounded-md file:border-0 file:bg-panel-2 file:px-3 file:py-2 file:text-fg" />
          <span className="block text-fg-dim">{t('feedback.imageLimit', 'Add up to 3 PNG, JPEG or WebP screenshots, 2 MB each.')}</span>
        </label>
        {!!screenshots.length && <div className="flex flex-wrap gap-3">{screenshots.map((image, index) => <div key={index} className="relative">
          <img src={image.dataUrl} alt={image.name} className="h-20 w-24 rounded-lg border border-edge object-cover" />
          <button type="button" disabled={busy} aria-label={`${t('feedback.remove', 'Remove screenshot')} ${image.name}`} onClick={() => setScreenshots(current => current.filter((_, i) => i !== index))}
            className="absolute -right-1 -top-1 rounded-full border border-edge bg-panel p-1"><X className="size-3" /></button>
        </div>)}</div>}
        {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end"><Button type="submit" disabled={busy || reading || !message.trim()}>
          {(busy || reading) && <Loader2 className="size-4 animate-spin" />}{t('feedback.submit', 'Submit feedback')}
        </Button></div>
      </form>}
    </DialogContent>
  </Dialog>
}
