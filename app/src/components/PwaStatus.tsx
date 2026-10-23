import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { useT } from '../lib/i18n'
import { applyPwaUpdate, watchPwaUpdates } from '../lib/pwa'

export function PwaStatus() {
  const t = useT()
  const [offline, setOffline] = useState(false)
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)
  const [dismissed, setDismissed] = useState<ServiceWorker | null>(null)
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine)
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    const stop = import.meta.env.PROD ? watchPwaUpdates(setWaiting) : () => {}
    return () => {
      stop()
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  const showUpdate = waiting && waiting !== dismissed
  if (!offline && !showUpdate) return null
  return (
    <aside className="fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 mx-auto max-w-md rounded-xl border border-border bg-background p-4 text-foreground shadow-lg" aria-label={t('pwa.status', 'App status')}>
      <output className="block" aria-live="polite">
        {offline ? <p className="text-sm">{t('pwa.offline', "You're offline. Reconnect to continue using Lovbase.")}</p> : <>
          <p className="text-sm font-medium">{t('pwa.update', 'A new version is available')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('pwa.saveFirst', 'Save your work and finish any AI conversation before refreshing.')}</p>
        </>}
      </output>
      {!offline && showUpdate && <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" disabled={updating} onClick={() => setDismissed(waiting)}>{t('pwa.later', 'Later')}</Button>
        <Button disabled={updating} onClick={() => { setUpdating(true); applyPwaUpdate(waiting) }}>{t('pwa.refresh', 'Refresh to update')}</Button>
      </div>}
    </aside>
  )
}
