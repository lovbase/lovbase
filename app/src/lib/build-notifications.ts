const ENABLED_KEY = 'lovbase-build-notifications'
const memoryClaims = new Set<string>()

export function desktopNotificationsEnabled() {
  try { return localStorage.getItem(ENABLED_KEY) === 'on' } catch { return false }
}

export function setDesktopNotificationsEnabled(enabled: boolean) {
  try { localStorage.setItem(ENABLED_KEY, enabled ? 'on' : 'off') } catch { /* Permission still controls delivery. */ }
}

/** One browser alert per job, including across polling retries, navigation and multiple tabs. */
export function claimBuildNotification(user: string, jobId: string) {
  const key = `lovbase-build-alerts:${user}`
  const memoryKey = `${key}:${jobId}`
  if (memoryClaims.has(memoryKey)) return false
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    const ids = Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string') : []
    if (ids.includes(jobId)) return false
    localStorage.setItem(key, JSON.stringify([...ids, jobId].slice(-200)))
  } catch { /* Disabled storage must not break in-app reminders. */ }
  memoryClaims.add(memoryKey)
  if (memoryClaims.size > 500) memoryClaims.delete(memoryClaims.values().next().value!)
  return true
}

export function buildNotificationUrl(projectId: string, appId: string) {
  return `/projects/${encodeURIComponent(projectId)}?app=${encodeURIComponent(appId)}`
}

export async function showBuildNotification(title: string, body: string, jobId: string, url: string) {
  if (!desktopNotificationsEnabled() || !('Notification' in window) || Notification.permission !== 'granted') return
  try {
    // showNotification also supports installed mobile PWAs, where the constructor can throw.
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
    if (registration?.active) {
      await registration.showNotification(title, { body, tag: `lovbase-${jobId}`, icon: '/icons/icon-192.png', data: { url } })
      return
    }
    const notification = new Notification(title, { body, tag: `lovbase-${jobId}` })
    notification.addEventListener('click', () => { window.focus(); window.location.assign(url); notification.close() }, { once: true })
  } catch { /* The in-app inbox remains available if browser/OS delivery fails. */ }
}
