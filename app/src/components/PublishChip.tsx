import { useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Check, ExternalLink, Loader2, Pencil, Rocket, Trash2 } from 'lucide-react'
import { publishApp, renameSubdomain, unpublishApp } from '../functions'
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

export function PublishChip({ projectId, appId, url, publishedAt, canCustomise, disabled, onChanged }: Props) {
  const t = useT()
  const dialogs = useDialogs()
  const doPublish = useServerFn(publishApp)
  const rename = useServerFn(renameSubdomain)
  const takeDown = useServerFn(unpublishApp)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [justDone, setJustDone] = useState(false)

  async function publish() {
    setBusy(true); setErr('')
    try {
      const r = await doPublish({ data: { projectId, appId } })
      if (r.ok) { track('app_published', { files: r.files }); setJustDone(true); setTimeout(() => setJustDone(false), 2500); onChanged() }
      else setErr(String(r.error).slice(-160))
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
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

  if (busy)
    return (
      <span className="flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] rounded-lg border border-edge bg-panel text-fg-mid">
        <Loader2 className="size-3.5 animate-spin" /> {t('builder.publishing', 'Publishing…')}
      </span>
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
