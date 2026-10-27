import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useServerFn } from '@tanstack/react-start'
import { Link } from '@tanstack/react-router'
import { Bell, Check, CircleAlert, X } from 'lucide-react'
import { myNotifications, readNotifications } from '../functions/feedback'
import { useT } from '../lib/i18n'
import { buildNotificationUrl, claimBuildNotification, desktopNotificationsEnabled, setDesktopNotificationsEnabled, showBuildNotification } from '../lib/build-notifications'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'

type Notice = Awaited<ReturnType<typeof myNotifications>>[number]

export function BuildNotifications({ userKey, expanded }: { userKey: string; expanded: boolean }) {
  const t = useT(), list = useServerFn(myNotifications), read = useServerFn(readNotifications)
  const [items, setItems] = useState<Notice[]>([]), [open, setOpen] = useState(false)
  const [toast, setToast] = useState<Notice | null>(null), [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const translations = useRef(t)
  useEffect(() => { translations.current = t }, [t])
  const title = (notice: Notice) => notice.kind === 'completed' ? t('notifications.completed', 'App generation completed') : t('notifications.failed', 'Task did not finish')
  useEffect(() => {
    let alive = true, polling = false
    const tick = async () => {
      if (polling || !navigator.onLine) return
      polling = true
      try {
        const notices = await list()
        if (!alive) return
        setItems(notices); setError('')
        // Old unread items stay in the inbox; only recent completions interrupt the user.
        for (const notice of notices.toReversed()) {
          if (Date.now() - new Date(notice.finishedAt).getTime() > 10 * 60_000) continue
          const announce = async () => {
            if (!alive || !claimBuildNotification(userKey, notice.id)) return
            setToast(notice)
            if (document.visibilityState === 'hidden') await showBuildNotification(
              notice.kind === 'completed' ? translations.current('notifications.completed', 'App generation completed') : translations.current('notifications.failed', 'Task did not finish'),
              notice.appName || notice.projectName, notice.id, buildNotificationUrl(notice.projectId,notice.appId))
          }
          if (navigator.locks) await navigator.locks.request(`lovbase-notification:${userKey}`, announce)
          else await announce()
        }
      } catch { if (alive) setError(translations.current('notifications.loadFailed', 'Could not load notifications. Retrying automatically.')) }
      finally { polling = false }
    }
    void tick()
    const timer = setInterval(() => void tick(), 5000)
    const refresh = () => { void tick() }
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh) }
  }, [list, userKey])

  async function dismiss(ids: string[]) {
    setBusy(true)
    try {
      await read({ data: { ids } })
      setItems(current => current.filter(item => !ids.includes(item.id)))
      setToast(current => current && ids.includes(current.id) ? null : current)
    } catch { setError(t('notifications.readFailed', 'Could not mark notifications as read. Please try again.')) }
    finally { setBusy(false) }
  }
  return <>
    <button type="button" title={t('notifications.title', 'Notifications')} aria-label={`${t('notifications.title', 'Notifications')} (${items.length})`} onClick={() => setOpen(true)}
      className={`relative flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-fg-mid hover:bg-panel-2 hover:text-fg ${expanded ? '' : 'justify-center'}`}>
      <Bell className="size-4 shrink-0" />{expanded && <span>{t('notifications.title', 'Notifications')}</span>}
      {!!items.length && <span className={`${expanded ? 'ml-auto' : 'absolute right-0 top-0'} rounded-full bg-accent px-1.5 text-[10px] text-on-accent`}>{items.length === 20 ? '20+' : items.length}</span>}
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[80dvh] overflow-y-auto bg-panel text-fg sm:max-w-lg">
        <DialogTitle>{t('notifications.title', 'Notifications')}</DialogTitle>
        <DialogDescription>{t('notifications.description', 'App generation results. Open an app to see the result.')}</DialogDescription>
        <NotificationSettings />
        {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
        {!items.length && <p className="py-5 text-sm text-fg-dim">{t('notifications.empty', 'No unread notifications.')}</p>}
        <div className="divide-y divide-edge">{items.map(notice => <div key={notice.id} className="flex items-start gap-3 py-3">
          {notice.kind === 'completed' ? <Check className="mt-1 size-4 shrink-0 text-emerald-600" /> : <CircleAlert className="mt-1 size-4 shrink-0 text-warn" />}
          <Link to="/projects/$projectId" params={{ projectId: notice.projectId }} search={{ app: notice.appId }} onClick={() => { setOpen(false); void dismiss([notice.id]) }} className="min-w-0 flex-1">
            <p className="text-sm font-medium">{title(notice)}</p><p className="mt-1 truncate text-xs text-fg-dim">{notice.projectName} · {notice.appName}</p>
          </Link>
          <button type="button" disabled={busy} aria-label={t('notifications.dismiss', 'Mark as read')} onClick={() => void dismiss([notice.id])} className="rounded p-1 hover:bg-panel-2"><X className="size-4" /></button>
        </div>)}</div>
        {!!items.length && <Button variant="ghost" disabled={busy} onClick={() => void dismiss(items.map(item => item.id))}>{t('notifications.readAll', 'Mark these as read')}</Button>}
      </DialogContent>
    </Dialog>
    {toast && !open && createPortal(<aside role="status" aria-live="polite" className="fixed bottom-5 right-4 z-40 w-[calc(100vw-2rem)] max-w-sm rounded-xl border border-edge bg-panel p-4 text-fg shadow-lg">
      <button type="button" aria-label={t('feedback.close', 'Close')} onClick={() => setToast(null)} className="absolute right-2 top-2 rounded p-1 hover:bg-panel-2"><X className="size-4" /></button>
      <p className="pr-6 text-sm font-medium">{title(toast)}</p><p className="mt-1 truncate text-xs text-fg-dim">{toast.projectName} · {toast.appName}</p>
      <Link to="/projects/$projectId" params={{ projectId: toast.projectId }} search={{ app: toast.appId }} onClick={() => void dismiss([toast.id])} className="mt-3 inline-block text-xs underline underline-offset-4">{t('notifications.open', 'View app')}</Link>
    </aside>, document.body)}
  </>
}

export function NotificationSettings() {
  const t = useT()
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default')
  const [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    const sync = () => { setPermission(window.isSecureContext && 'Notification' in window ? Notification.permission : 'unsupported'); setEnabled(desktopNotificationsEnabled()) }
    sync(); window.addEventListener('focus',sync); window.addEventListener('storage',sync)
    return () => { window.removeEventListener('focus',sync); window.removeEventListener('storage',sync) }
  }, [])
  return <section className="space-y-3 rounded-xl border border-edge p-4">
    <h2 className="text-sm font-medium">{t('notifications.desktop', 'Desktop notifications')}</h2>
    <p className="text-xs leading-relaxed text-fg-dim">{t('notifications.hint', 'Get a browser notification when generation finishes in the background. Keep Lovbase open in a tab; closing all tabs stops these reminders.')}</p>
    {permission === 'unsupported' ? <p className="text-xs text-fg-dim">{t('notifications.unsupported', 'This browser does not support notifications here.')}</p>
      : permission === 'denied' ? <p className="text-xs text-fg-dim">{t('notifications.denied', 'Notifications are blocked. Allow them in your browser’s site settings to enable reminders.')}</p>
      : <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try {
          if (enabled && permission === 'granted') { setDesktopNotificationsEnabled(false); setEnabled(false); return }
          const next = await Notification.requestPermission()
          setPermission(next); setDesktopNotificationsEnabled(next === 'granted'); setEnabled(next === 'granted')
        } catch { setError(t('notifications.permissionFailed', 'Could not enable notifications. Please try again.')) }
        finally { setBusy(false) }
      }}>{enabled && permission === 'granted' ? t('notifications.disable', 'Turn off notifications') : t('notifications.enable', 'Enable notifications')}</Button>}
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
  </section>
}
