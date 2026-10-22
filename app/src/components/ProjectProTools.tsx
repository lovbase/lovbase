import { useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { ArrowDownToLine, Database, FileCode2, LoaderCircle, LockKeyhole } from 'lucide-react'
import { directDatabase } from '../functions/account'
import { useT } from '../lib/i18n'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

type Info = Awaited<ReturnType<typeof directDatabase>>
export function ProjectProTools({ projectId, plan }: { projectId: string; plan: string }) {
  const t = useT(),
    call = useServerFn(directDatabase)
  const [open, setOpen] = useState(false),
    [info, setInfo] = useState<Info | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')
  if (plan === 'free') return null
  async function action(action: 'info' | 'create' | 'revoke') {
    setBusy(true)
    setError('')
    setPassword('')
    try {
      const r = await call({ data: { projectId, action } })
      setInfo(r)
      if ('password' in r && typeof r.password === 'string') setPassword(r.password)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        className="inline-flex h-7 items-center rounded-lg border border-edge px-2.5 text-[12px] font-medium text-fg-mid transition-colors hover:border-edge-strong hover:bg-panel-2 hover:text-fg cursor-pointer"
        onClick={() => {
          setOpen(true)
          setInfo(null)
          void action('info')
        }}
      >
        {t('pro.tools', 'Pro tools')}
      </button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          if (!v) setPassword('')
        }}
      >
        <DialogContent className="w-[calc(100%-2rem)] gap-0 overflow-hidden rounded-2xl border border-edge bg-panel p-0 text-fg shadow-2xl sm:max-w-xl">
          <div className="border-b border-edge px-5 py-4 sm:px-6">
            <DialogTitle className="text-[15px] font-semibold">{t('pro.tools', 'Pro tools')}</DialogTitle>
            <DialogDescription className="mt-1 text-[12px] text-fg-dim">
              {t('pro.toolsDescription', 'Export project data or manage a read-only database connection.')}
            </DialogDescription>
          </div>

          <div className="max-h-[min(70dvh,36rem)] space-y-5 overflow-y-auto p-5 sm:p-6">
            <section className="space-y-2.5">
              <p className="eyebrow">{t('pro.exports', 'Project exports')}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <a
                  href={`/api/projects/${encodeURIComponent(projectId)}/export/sql`}
                  className="group flex min-w-0 items-center gap-3 rounded-xl border border-edge bg-panel px-3.5 py-3 transition-colors hover:border-edge-strong hover:bg-panel-2"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-edge bg-panel-2 text-fg-mid group-hover:text-fg">
                    <Database className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-fg">{t('pro.sql', 'Export full SQL')}</span>
                    <span className="mt-0.5 block text-[11px] text-fg-dim">.sql</span>
                  </span>
                  <ArrowDownToLine className="size-4 shrink-0 text-fg-dim transition-colors group-hover:text-fg" />
                </a>
                <a
                  href={`/api/projects/${encodeURIComponent(projectId)}/export/source`}
                  className="group flex min-w-0 items-center gap-3 rounded-xl border border-edge bg-panel px-3.5 py-3 transition-colors hover:border-edge-strong hover:bg-panel-2"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-edge bg-panel-2 text-fg-mid group-hover:text-fg">
                    <FileCode2 className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-fg">{t('pro.source', 'Export source ZIP')}</span>
                    <span className="mt-0.5 block text-[11px] text-fg-dim">.zip</span>
                  </span>
                  <ArrowDownToLine className="size-4 shrink-0 text-fg-dim transition-colors group-hover:text-fg" />
                </a>
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Database className="size-4 text-fg-dim" />
                <h3 className="text-[13px] font-semibold">{t('pro.database', 'Read-only database connection')}</h3>
                {info?.enabled && (
                  <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-ok/20 bg-ok/10 px-2 py-0.5 text-[10px] font-medium text-ok">
                    <span className="size-1.5 rounded-full bg-ok" />
                    {t('pro.enabled', 'Active')}
                  </span>
                )}
              </div>

              {busy && !info ? (
                <div className="flex items-center gap-2 rounded-xl border border-edge bg-panel-2 px-3.5 py-4 text-[12px] text-fg-dim" role="status">
                  <LoaderCircle className="size-4 animate-spin" />
                  {t('pro.loading', 'Loading connection details…')}
                </div>
              ) : info && !info.configured ? (
                <p className="rounded-xl border border-edge bg-panel-2 px-3.5 py-3 text-[12px] leading-relaxed text-fg-dim">
                  {t('pro.unconfigured', 'External database access has not been configured by the administrator.')}
                </p>
              ) : info ? (
                <>
                  <div className="overflow-hidden rounded-xl border border-edge bg-panel-2">
                    <ConnectionRow label={t('pro.host', 'Host')} value={`${info.host}:${info.port}`} />
                    <ConnectionRow label={t('pro.databaseName', 'Database')} value={info.database} />
                    <ConnectionRow label={t('pro.username', 'Username')} value={info.username} />
                    <ConnectionRow label={t('pro.schema', 'Schema')} value={info.schema} />
                    <ConnectionRow label={t('pro.sslMode', 'SSL mode')} value={info.sslmode} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy} onClick={() => action('create')}>
                      <LockKeyhole className="size-3.5" />
                      {info.enabled ? t('pro.reset', 'Reset password') : t('pro.create', 'Create credentials')}
                    </Button>
                    {info.enabled && (
                      <Button disabled={busy} variant="outline" onClick={() => action('revoke')}>
                        {t('pro.revoke', 'Revoke')}
                      </Button>
                    )}
                  </div>
                </>
              ) : null}
            </section>

            {password && (
              <div className="rounded-xl border border-edge bg-panel-2 p-3.5">
                <p className="mb-2 flex items-center gap-2 text-[12px] font-medium text-fg">
                  <LockKeyhole className="size-3.5 text-fg-dim" />
                  {t('pro.passwordReady', 'New database password')}
                </p>
                <code className="block select-all break-all rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-[12px] text-fg">{password}</code>
                <p className="mt-2 text-[11px] text-fg-dim">{t('pro.once', 'Save this password now. It is only shown once.')}</p>
              </div>
            )}
            {error && (
              <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[12px] text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ConnectionRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 border-b border-edge px-3.5 py-2.5 last:border-0 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <span className="text-[11px] text-fg-dim">{label}</span>
      <code className="min-w-0 break-all font-mono text-[11px] text-fg-mid">{value || '—'}</code>
    </div>
  )
}
