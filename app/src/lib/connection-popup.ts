const channelPrefix = 'lovbase:connection-auth:'
const messageType = 'lovbase:connection-auth-result'

export type ConnectionAuthResult = 'connected' | 'failed' | 'identity_changed'
export type ConnectionPopup = {
  returnPath: string
  navigate: (url: string) => void
  close: () => void
  dispose: () => void
}

function isResult(value: unknown): value is ConnectionAuthResult {
  return value === 'connected' || value === 'failed' || value === 'identity_changed'
}

// Called synchronously from a click, before fetching authentication metadata or a Connect Link.
export function openConnectionPopup(onComplete: (result: ConnectionAuthResult) => void, title: string, browser = window): ConnectionPopup | null {
  const requestId = crypto.randomUUID()
  const width = Math.min(520, browser.screen.availWidth), height = Math.min(720, browser.screen.availHeight)
  const left = Math.max(0, browser.screenX + (browser.outerWidth - width) / 2)
  const top = Math.max(0, browser.screenY + (browser.outerHeight - height) / 2)
  const popup = browser.open('about:blank', `lovbase-auth-${requestId}`, `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`)
  if (!popup) return null
  popup.document.title = title
  popup.document.body.textContent = title
  const key = channelPrefix + requestId
  let channel: BroadcastChannel | undefined
  try { channel = new browser.BroadcastChannel(key) } catch { /* postMessage and storage remain available */ }
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    browser.clearTimeout(timeout)
    browser.removeEventListener('message', onMessage)
    browser.removeEventListener('storage', onStorage)
    channel?.close()
  }
  const receive = (data: unknown) => {
    if (disposed || !data || typeof data !== 'object' || !('type' in data) || data.type !== messageType ||
      !('requestId' in data) || data.requestId !== requestId || !('result' in data) || !isResult(data.result)) return
    dispose()
    popup.close()
    onComplete(data.result)
  }
  const onMessage = (event: MessageEvent) => {
    if (event.origin === browser.location.origin && event.source === popup) receive(event.data)
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== key || !event.newValue) return
    try { receive(JSON.parse(event.newValue)) } catch { /* unrelated or malformed storage event */ }
  }
  browser.addEventListener('message', onMessage)
  browser.addEventListener('storage', onStorage)
  channel?.addEventListener('message', event => receive(event.data))
  // Providers can sever window.opener with COOP. Keep the same-origin channel alive even then,
  // and expire it with the server's authorization attempt rather than relying on popup.closed.
  const timeout = browser.setTimeout(dispose, 30 * 60 * 1000)
  return {
    returnPath: `/connection-callback?requestId=${requestId}`,
    navigate: url => { if (popup.closed) throw new Error('Authorization window was closed. Please try again.'); popup.location.href = url },
    close: () => { dispose(); popup.close() },
    dispose,
  }
}

export function completeConnectionPopup(browser = window): ConnectionAuthResult | null {
  const requestId = new URLSearchParams(browser.location.search).get('requestId')
  const result = new URLSearchParams(browser.location.hash.slice(1)).get('connections')
  if (!requestId || !/^[\da-f-]{36}$/i.test(requestId) || !isResult(result)) return null
  const data = { type: messageType, requestId, result }
  const key = channelPrefix + requestId
  try { browser.opener?.postMessage(data, browser.location.origin) } catch { /* provider isolated the opener */ }
  try {
    const channel = new browser.BroadcastChannel(key)
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is restricted to the same origin and has no targetOrigin argument.
    channel.postMessage(data)
    channel.close()
  } catch { /* older browsers use storage or postMessage */ }
  try {
    // Only the outcome is sent, never credentials. Remove it immediately after notifying.
    browser.localStorage.setItem(key, JSON.stringify(data))
    browser.localStorage.removeItem(key)
  } catch { /* storage may be unavailable in private browsing */ }
  browser.close()
  return result
}
