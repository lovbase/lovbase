import { useEffect, useRef, useState } from 'react'

type StreamOptions = {
  url: string
  onSnapshot?: (value: any) => void
  onActivity?: (value: any) => void
  onNotifications?: (value: any) => void
  onError?: () => void
}

function read(event: Event): any {
  try { return JSON.parse((event as MessageEvent).data) } catch { return null }
}

/** Native EventSource reconnects with Last-Event-ID semantics; the server sends a fresh snapshot. */
export function useSse({ url, onSnapshot, onActivity, onNotifications, onError }: StreamOptions) {
  const handlers = useRef({ onSnapshot, onActivity, onNotifications, onError })
  handlers.current = { onSnapshot, onActivity, onNotifications, onError }
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !url) return
    const source = new EventSource(url, { withCredentials: true })
    const snapshot = (event: Event) => { const value = read(event); if (value) handlers.current.onSnapshot?.(value) }
    const activity = (event: Event) => { const value = read(event); if (value) handlers.current.onActivity?.(value) }
    const notifications = (event: Event) => { const value = read(event); if (value) handlers.current.onNotifications?.(value) }
    source.addEventListener('snapshot', snapshot)
    source.addEventListener('activity', activity)
    source.addEventListener('notifications', notifications)
    source.onopen = () => setConnected(true)
    source.onerror = () => { setConnected(false); handlers.current.onError?.() }
    return () => {
      source.removeEventListener('snapshot', snapshot)
      source.removeEventListener('activity', activity)
      source.removeEventListener('notifications', notifications)
      source.close()
      setConnected(false)
    }
  }, [url])
  return connected
}
