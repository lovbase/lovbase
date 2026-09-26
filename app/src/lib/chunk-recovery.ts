/**
 * A tab can outlive a deployment and ask the new server for a lazy chunk from the previous build.
 * Vite emits this event before surfacing the failed import to React, giving us one chance to load
 * the current document and its current asset manifest. The cooldown leaves repeated failures visible
 * to the normal error boundary instead of trapping the user in a reload loop.
 */
export function installChunkRecovery(browser: Window = window) {
  const marker = 'lovbase:chunk-reload'
  const cooldownMs = 15_000

  browser.addEventListener('vite:preloadError', (event) => {
    const now = Date.now()
    let lastReload = 0
    try {
      lastReload = Number(browser.sessionStorage.getItem(marker)) || 0
    } catch {
      // Without a marker that survives reload, recovery could trap the tab in a reload loop.
      return
    }

    if (now - lastReload < cooldownMs) return

    try {
      browser.sessionStorage.setItem(marker, String(now))
    } catch {
      return
    }
    event.preventDefault()
    browser.location.reload()
  })
}

// This must run before the module entry point, including when that entry point is the stale chunk.
export const chunkRecoveryScript = `(${installChunkRecovery.toString()})()`
