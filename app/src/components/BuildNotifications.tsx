import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useServerFn } from '@tanstack/react-start'
import { Link } from '@tanstack/react-router'
import { Bell, Check, CircleAlert, X } from 'lucide-react'
import { myNotifications, readNotifications } from '../functions/feedback'
import { useT } from '../lib/i18n'
import { claimBuildNotification } from '../lib/build-notifications'
import { useSse } from '../lib/sse'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'

type Notice = Awaited<ReturnType<typeof myNotifications>>[number]

export function BuildNotifications({ userKey, expanded }: { userKey: string; expanded: boolean }) {
  const t = useT(), read = useServerFn(readNotifications)
  const [items, setItems] = useState<Notice[]>([]), [open, setOpen] = useState(false)
  const [toast, setToast] = useState<Notice | null>(null), [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const title = (notice: Notice) => notice.kind === 'completed' ? t('notifications.completed', 'App generation completed') : t('notifications.failed', 'Task did not finish')
  const announce = useRef<(notices: Notice[]) => void>(() => {})
  announce.current = (notices) => {
    setItems(notices); setError('')
    // Push handles system notifications. The page only raises a deduplicated in-app toast.
    for (const notice of [...notices].reverse()) {
      if (Date.now() - new Date(notice.finishedAt).getTime() > 10 * 60_000) continue
      if (claimBuildNotification(userKey, notice.id)) setToast(notice)
    }
  }
  useSse({
    url: '/api/events?scope=notifications',
    onNotifications: (notices) => { if (Array.isArray(notices)) announce.current(notices) },
    onError: () => setError(t('notifications.loadFailed', 'Could not load notifications. Retrying automatically.')),
  })

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
    let alive = true
    const sync = async () => {
      const supported = window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window
      if (!supported) { setPermission('unsupported'); setEnabled(false); return }
      setPermission(Notification.permission)
      const config = await fetch('/api/push/config').then((response) => response.ok ? response.json() : null).catch(() => null) as { publicKey?: string } | null
      if (!config?.publicKey) { setPermission('unsupported'); setEnabled(false); return }
      const registration = await navigator.serviceWorker.getRegistration()
      const subscription = await registration?.pushManager.getSubscription()
      if (alive) setEnabled(!!subscription)
    }
    const onFocus = () => void sync()
    void sync(); window.addEventListener('focus', onFocus)
    return () => { alive = false; window.removeEventListener('focus', onFocus) }
  }, [])
  return <section className="space-y-3 rounded-xl border border-edge p-4">
    <h2 className="text-sm font-medium">{t('notifications.desktop', 'Push notifications')}</h2>
    <p className="text-xs leading-relaxed text-fg-dim">{t('notifications.hint', 'Get a notification when a successful build finishes, even after closing this page.')}</p>
    {permission === 'unsupported' ? <p className="text-xs text-fg-dim">{t('notifications.unsupported', 'This browser does not support notifications here.')}</p>
      : permission === 'denied' ? <p className="text-xs text-fg-dim">{t('notifications.denied', 'Notifications are blocked. Allow them in your browser’s site settings to enable reminders.')}</p>
      : <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try {
          const registration = await navigator.serviceWorker.ready
          if (enabled && permission === 'granted') {
            const subscription = await registration.pushManager.getSubscription()
            if (subscription) {
              await fetch('/api/push/subscription', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: subscription.endpoint }) })
              await subscription.unsubscribe()
            }
            setEnabled(false); return
          }
          const next = await Notification.requestPermission()
          setPermission(next)
          if (next !== 'granted') return
          const config = await fetch('/api/push/config').then(r => r.json()) as { publicKey?: string }
          if (!config.publicKey) throw new Error('Push is not configured')
          let subscription = await registration.pushManager.getSubscription()
          if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(config.publicKey) })
          await fetch('/api/push/subscription', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription.toJSON()) }).then(r => { if (!r.ok) throw new Error('subscription failed') })
          setEnabled(true)
        } catch { setError(t('notifications.permissionFailed', 'Could not enable notifications. Please try again.')) }
        finally { setBusy(false) }
      }}>{enabled && permission === 'granted' ? t('notifications.disable', 'Turn off notifications') : t('notifications.enable', 'Enable notifications')}</Button>}
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
  </section>
}

function decodeKey(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const bytes = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding)
  return Uint8Array.from(bytes, (char) => char.charCodeAt(0))
}
