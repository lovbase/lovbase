import { useEffect, useRef, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Check, ExternalLink, Loader2, Pencil, Rocket, Trash2 } from 'lucide-react'
import { publishApp, publishStatus, renameSubdomain, unpublishApp } from '../functions'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useT } from '../lib/i18n'
import { useDialogs } from './Dialogs'
import { track } from '../lib/posthog'

// Publishing has three states and people need to tell them apart at a glance: never published,
// working, and live. A live app shows its address as the control itself, so the address is the
// status rather than a note beside a button.

type Props = {
  projectId: string
  appId: string
  url: string | null
  publishedAt: string | null
  canCustomise: boolean
  disabled: boolean
  onChanged: () => void
}

const publishing = (task: { status: string } | null) => !!task && ['queued', 'waiting_capacity', 'starting', 'running', 'finalizing', 'cancelling'].includes(task.status)

export function PublishChip({ projectId, appId, url, publishedAt, canCustomise, disabled, onChanged }: Props) {
  const t = useT()
  const dialogs = useDialogs()
  const doPublish = useServerFn(publishApp)
  const getStatus = useServerFn(publishStatus)
  const rename = useServerFn(renameSubdomain)
  const takeDown = useServerFn(unpublishApp)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [justDone, setJustDone] = useState(false)
  type Task = NonNullable<Awaited<ReturnType<typeof publishStatus>>>
  const [task, setTask] = useState<Task | null>(null)
  const taskRef = useRef<Task | null>(null)
  const requestId = useRef<string | null>(null)
  const revision = useRef(0)
  const submitting = useRef(false)
  const handled = useRef<string | null>(null)
  const changed = useRef(onChanged)
  useEffect(() => { changed.current = onChanged }, [onChanged])
  const [statusError, setStatusError] = useState(false)
  const activeTask = publishing(task)

  function acceptTask(next: Task | null) {
    const previous = taskRef.current
    taskRef.current = next
    setTask(next)
    if (!next || publishing(next) || handled.current === next.id) return
    handled.current = next.id
    const requested = !!requestId.current
    requestId.current = null
    if (next.status === 'succeeded') {
      setErr('')
      if (requested || previous && (previous.id !== next.id || previous.status !== 'succeeded')) {
        track('app_published', { files: next.files }); setJustDone(true); changed.current()
      }
    } else setErr(next.error || t('publish.failed', 'Publishing did not complete. Please try again.'))
  }
  const accept = useRef(acceptTask)
  useEffect(() => { accept.current = acceptTask })

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const currentRevision = revision.current
      try {
        if (submitting.current) return
        const next = await getStatus({ data: { projectId, appId, taskId: publishing(taskRef.current) ? taskRef.current?.id : undefined } })
        if (!stopped && !submitting.current && currentRevision === revision.current) {
          accept.current(next); setStatusError(false)
        }
      } catch { if (!stopped) setStatusError(true) }
      finally { if (!stopped) timer = setTimeout(poll, publishing(taskRef.current) || submitting.current ? 2000 : 10_000) }
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [projectId, appId, getStatus, task?.id])

  useEffect(() => {
    if (!justDone) return
    const timer = setTimeout(() => setJustDone(false), 2500)
    return () => clearTimeout(timer)
  }, [justDone])

  async function publish() {
    if (submitting.current || publishing(taskRef.current)) return
    submitting.current = true
    revision.current++
    setBusy(true); setErr('')
    try {
      requestId.current ??= crypto.randomUUID()
      const r = await doPublish({ data: { projectId, appId, requestId: requestId.current } })
      acceptTask(r)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { revision.current++; submitting.current = false; setBusy(false) }
  }

  async function customise() {
    const next = await dialogs.prompt({
      title: t('publish.customise', 'Custom subdomain'),
      description: t('publish.promptSubdomain', 'Custom subdomain (lowercase letters, digits, hyphens)'),
      label: t('publish.subdomainLabel', 'Subdomain'),
      defaultValue: url ? new URL(url).hostname.split('.')[0] : '',
    })
    if (!next) return
    setBusy(true); setErr('')
    try { await rename({ data: { projectId, appId, slug: next } }); await publish() }
    catch (e) { setErr((e instanceof Error ? e.message : String(e)).replace(/^LIMIT:/, '')) }
    finally { setBusy(false) }
  }

  if (busy || activeTask)
    return (
      <output title={t('publish.background', 'Publishing continues in the background. You can leave this page.')}
        className="flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] rounded-lg border border-edge bg-panel text-fg-mid">
        <Loader2 className="size-3.5 animate-spin" /> {statusError
          ? t('publish.reconnecting', 'Reconnecting to publish status…')
          : task && ['queued', 'waiting_capacity'].includes(task.status)
            ? t('publish.queued', 'Queued for publishing…') : t('builder.publishing', 'Publishing…')}
      </output>
    )

  if (!url)
    return (
      <div className="flex items-center gap-2">
        <button onClick={publish} disabled={disabled} title={disabled ? t('builder.publishNeedsUi', 'Generate an interface first') : t('builder.publishHint', 'Build the current interface')}
          className="flex items-center gap-1.5 px-3.5 py-1.5 text-[12.5px] rounded-lg border border-edge bg-panel text-fg font-medium hover:border-edge-strong disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer">
          <Rocket className="size-3.5" /> {t('nav.publish', 'Publish')}
        </button>
        {err && <span className="text-[11.5px] text-warn max-w-[16rem] truncate">{err}</span>}
      </div>
    )

  const host = new URL(url).hostname
  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button className="flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 rounded-lg border border-edge bg-panel hover:border-edge-strong transition-colors cursor-pointer" />
          }>
          <span className={`size-1.5 rounded-full shrink-0 ${justDone ? 'bg-ok' : 'bg-ok/70'}`} />
          <span className="text-[12px] font-mono text-fg-mid max-w-[15rem] truncate">{host}</span>
          {justDone && <Check className="size-3.5 text-ok" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuItem render={<a href={url} target="_blank" rel="noreferrer" />}>
            <ExternalLink className="size-4" /> {t('publish.open', 'Open live app')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigator.clipboard?.writeText(url)}>
            <Check className="size-4" /> {t('publish.copy', 'Copy link')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={publish}>
            <Rocket className="size-4" /> {t('publish.again', 'Republish current version')}
          </DropdownMenuItem>
          {canCustomise && (
            <DropdownMenuItem onClick={customise}>
              <Pencil className="size-4" /> {t('publish.customise', 'Custom subdomain')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={async () => {
            if (!(await dialogs.confirm({
              title: t('publish.unpublishTitle', 'Take the app offline?'),
              description: t('publish.confirmUnpublish', 'The address stops working immediately. Continue?'),
              confirmLabel: t('publish.unpublish', 'Take offline'), destructive: true,
            }))) return
            setBusy(true)
            try { await takeDown({ data: { projectId, appId } }); track('app_unpublished'); onChanged() }
            catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
            finally { setBusy(false) }
          }}>
            <Trash2 className="size-4" /> {t('publish.unpublish', 'Take offline')}
          </DropdownMenuItem>
          {publishedAt && (
            <>
              <DropdownMenuSeparator />
              <p className="px-2 py-1.5 text-[11.5px] text-fg-dim tabular-nums">
                {t('publish.lastAt', 'Last published')} {new Date(publishedAt).toISOString().slice(0, 16).replace('T', ' ')}
              </p>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {err && <span className="text-[11.5px] text-warn max-w-[14rem] truncate">{err}</span>}
    </div>
  )
}
