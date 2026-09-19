// Lovbase analytics beacon: pageviews on load and SPA navigation, time-on-page on leave.
// Anonymous: the server derives a daily-rotating visitor id; nothing is stored in the browser.
const base = import.meta.env.VITE_LOVBASE_URL as string
const ws = import.meta.env.VITE_LOVBASE_WORKSPACE as string
const url = `${base}/w/${ws}/events`

let startedAt = Date.now()
let currentPath = location.pathname

function send(events: object[], beacon = false) {
  const body = JSON.stringify({ events })
  if (beacon && navigator.sendBeacon) { navigator.sendBeacon(url, new Blob([body], { type: 'application/json' })); return }
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {})
}

function pageview() {
  currentPath = location.pathname
  startedAt = Date.now()
  send([{ type: 'pageview', path: currentPath, referrer: document.referrer || null }])
}
function leave() {
  send([{ type: 'leave', path: currentPath, duration_ms: Date.now() - startedAt }], true)
}

export function startAnalytics() {
  if (!base || !ws || (window as any).__lovbaseAnalytics) return
  ;(window as any).__lovbaseAnalytics = true
  pageview()
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m]
    history[m] = function (...args: any[]) { const r = (orig as any).apply(this, args); if (location.pathname !== currentPath) { leave(); pageview() } return r }
  }
  addEventListener('popstate', () => { if (location.pathname !== currentPath) { leave(); pageview() } })
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leave(); else startedAt = Date.now() })
  addEventListener('pagehide', leave)
}
