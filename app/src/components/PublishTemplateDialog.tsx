import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { getTemplateDraft, publishTemplate, withdrawTemplate } from '../functions/templates'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n, useT } from '../lib/i18n'
import { useDialogs } from './Dialogs'
import { track } from '../lib/posthog'

type Draft = Awaited<ReturnType<typeof getTemplateDraft>>

/**
 * Share a published app as a template. What goes out is the published version's tables and
 * interface, never its rows; it shows up in the gallery once an admin approves it.
 */
export function PublishTemplateDialog({ projectId, appId, appName, open, onOpenChange }: {
  projectId: string
  /** Absent when opened from a project card: the project's published app is used. */
  appId?: string
  appName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const { locale } = useI18n()
  const dialogs = useDialogs()
  const load = useServerFn(getTemplateDraft)
  const submit = useServerFn(publishTemplate)
  const withdraw = useServerFn(withdrawTemplate)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  useEffect(() => {
    if (!open) return
    setDraft(null); setError(''); setSent(false)
    void load({ data: { projectId, appId } }).then((d) => {
      setDraft(d)
      setName(d.current?.name ?? (appName || d.app?.name || ''))
      setDescription(d.current?.description ?? '')
      setCategoryId(d.current?.categoryId ?? null)
      setTags(d.current?.tags.join(', ') ?? '')
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [open, projectId, appId, appName, load])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      if (!draft?.app) return
      await submit({ data: { projectId, appId: draft.app.id, name, description, categoryId, tags: tags.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, 5) } })
      track('template_published', { category: categoryId })
      setSent(true)
    } catch (err) { setError(err instanceof Error ? err.message.replace(/^\w+:/, '') : String(err)) } finally { setBusy(false) }
  }

  const current = draft?.current
  const status = current && !sent ? current.status : sent ? 'pending' : null

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 data-open:animate-in data-open:fade-in-0" />
        <DialogPrimitive.Popup className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-2rem)] max-w-[520px] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl bg-panel text-fg p-7 shadow-2xl outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[.98]">
          <DialogPrimitive.Close aria-label={t('common.close', 'Close')} className="absolute top-4 right-4 size-8 grid place-items-center rounded-lg text-fg-dim hover:text-fg hover:bg-panel-2 cursor-pointer">
            <X className="size-4" />
          </DialogPrimitive.Close>
          <DialogPrimitive.Title className="text-[18px] font-semibold tracking-tight">{t('tpl.publish.title', 'Publish as template')}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-[13px] text-fg-dim mt-1.5 leading-5">
            {t('tpl.publish.sub', 'Shares the tables and interface of the published version. Your data stays with you.')}
          </DialogPrimitive.Description>

          {status && (
            <div className="mt-5 flex items-start justify-between gap-3 rounded-xl bg-panel-2 px-4 py-3">
              <div className="min-w-0">
                <p className="text-[13.5px] font-medium flex items-center gap-2">
                  <span className={`size-1.5 rounded-full ${status === 'approved' ? 'bg-ok' : status === 'rejected' ? 'bg-warn' : 'bg-fg-dim'}`} />
                  {status === 'approved' ? (current?.featured ? t('tpl.status.featured', 'Live and featured') : t('tpl.status.approved', 'Live in the gallery'))
                    : status === 'rejected' ? t('tpl.status.rejected', 'Not approved') : t('tpl.status.pending', 'In review')}
                </p>
                {status === 'rejected' && current?.reviewNote && <p className="text-[13px] text-fg-dim mt-1">{current.reviewNote}</p>}
                {status === 'approved' && current && <p className="text-[13px] text-fg-dim mt-1 tabular-nums">{current.uses} {t('tpl.uses', 'uses')}</p>}
                {sent && <p className="text-[13px] text-fg-dim mt-1">{t('tpl.publish.sent', 'Submitted. It appears in the gallery once approved.')}</p>}
              </div>
              {current && !sent && (
                <button type="button" className="shrink-0 text-[13px] text-fg-dim hover:text-warn cursor-pointer" onClick={async () => {
                  if (!(await dialogs.confirm({ title: t('tpl.withdraw.title', 'Withdraw this template?'), description: t('tpl.withdraw.desc', 'It leaves the gallery. Projects already made from it are not affected.'), confirmLabel: t('tpl.withdraw', 'Withdraw'), destructive: true }))) return
                  await withdraw({ data: { id: current.id } }); onOpenChange(false)
                }}>{t('tpl.withdraw', 'Withdraw')}</button>
              )}
            </div>
          )}

          {draft && !draft.app?.published ? (
            <div className="mt-6 rounded-xl bg-panel-2 px-4 py-4">
              <p className="text-[13.5px] text-fg">{t('tpl.publish.needsPublish', 'Publish the app first')}</p>
              <p className="text-[13px] text-fg-dim mt-1 leading-5">{t('tpl.publish.needsPublishHint', 'A template is made from the published version. Publish it from the project, then come back here.')}</p>
              <div className="mt-4 flex justify-end">
                <Button render={<Link to="/projects/$projectId" params={{ projectId }} onClick={() => onOpenChange(false)} />}>{t('tpl.publish.openProject', 'Open project')}</Button>
              </div>
            </div>
          ) : !draft && !error ? <p className="mt-6 text-[13.5px] text-fg-dim">{t('common.loading', 'Loading…')}</p> : !sent && (
            <form onSubmit={send} className="mt-6 space-y-5">
              <label className="block">
                <span className="block text-[13px] font-medium mb-2">{t('tpl.field.name', 'Name')}</span>
                <Input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="block">
                <span className="block text-[13px] font-medium mb-2">{t('tpl.field.description', 'Description')}</span>
                <textarea maxLength={280} rows={3} value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('tpl.field.descriptionHint', 'What it does and who it is for')}
                  className="block w-full rounded-lg border border-input bg-transparent px-3 py-2 text-[14px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 resize-none placeholder:text-fg-dim" />
              </label>
              {!!draft?.categories.length && (
                <div>
                  <span className="block text-[13px] font-medium mb-2">{t('tpl.field.category', 'Category')}</span>
                  <div className="flex flex-wrap gap-2">
                    {draft.categories.map((c) => (
                      <button key={c.id} type="button" onClick={() => setCategoryId(categoryId === c.id ? null : c.id)}
                        className={`h-8 px-3.5 rounded-full text-[13px] transition-colors cursor-pointer ${categoryId === c.id ? 'bg-fg text-ink' : 'border border-edge text-fg-mid hover:text-fg'}`}>
                        {locale === 'zh' ? c.nameZh : c.nameEn}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <label className="block">
                <span className="block text-[13px] font-medium mb-2">{t('tpl.field.tags', 'Tags')}</span>
                <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('tpl.field.tagsHint', 'Up to 5, separated by commas')} />
              </label>
              {error && <p role="alert" className="text-[13px] text-warn">{error}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('dialog.cancel', 'Cancel')}</Button>
                <Button type="submit" disabled={busy || !name.trim()}>
                  {current ? t('tpl.publish.update', 'Submit update') : t('tpl.publish.submit', 'Submit for review')}
                </Button>
              </div>
            </form>
          )}
          {error && !draft && <p role="alert" className="mt-6 text-[13px] text-warn">{error}</p>}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
