/** Browser-only call sites live in effects; importing this module is safe during SSR. */
export function watchPwaUpdates(onUpdate: (worker: ServiceWorker) => void, browser: Window = window) {
  if (!browser.isSecureContext || !('serviceWorker' in browser.navigator)) return () => {}
  const container = browser.navigator.serviceWorker
  let disposed = false
  let registration: ServiceWorkerRegistration | undefined
  let installing: ServiceWorker | null = null
  let lastCheck = 0

  const notify = () => {
    if (!disposed && registration?.waiting && container.controller) onUpdate(registration.waiting)
  }
  const trackInstall = () => {
    installing?.removeEventListener('statechange', notify)
    installing = registration?.installing ?? null
    installing?.addEventListener('statechange', notify)
    notify()
  }
  const check = () => {
    if (browser.document.visibilityState !== 'visible' || !browser.navigator.onLine || Date.now() - lastCheck < 60_000) return
    lastCheck = Date.now()
    void registration?.update().catch(() => {})
  }

  void container.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(value => {
    if (disposed) return
    registration = value
    registration.addEventListener('updatefound', trackInstall)
    trackInstall()
  }).catch(error => { console.warn('PWA registration failed', error) })

  browser.document.addEventListener('visibilitychange', check)
  browser.addEventListener('online', check)
  const interval = browser.setInterval(check, 60 * 60 * 1000)
  return () => {
    disposed = true
    browser.clearInterval(interval)
    browser.document.removeEventListener('visibilitychange', check)
    browser.removeEventListener('online', check)
    registration?.removeEventListener('updatefound', trackInstall)
    installing?.removeEventListener('statechange', notify)
  }
}

/** Reload only the tab whose user accepted the update, never every controlled tab. */
export function applyPwaUpdate(worker: ServiceWorker, browser: Window = window) {
  const activated = () => {
    if (worker.state === 'activated' || worker.state === 'redundant') {
      worker.removeEventListener('statechange', activated)
      browser.location.reload()
    }
  }
  worker.addEventListener('statechange', activated)
  activated()
  // ServiceWorker.postMessage has no targetOrigin parameter (unlike Window.postMessage).
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  if (worker.state === 'installed') worker.postMessage({ type: 'SKIP_WAITING' })
}
