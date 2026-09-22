import { useEffect, useRef } from 'react'
import { readTheme, isDark } from '../lib/theme'

/**
 * Cloudflare Turnstile, drawn explicitly so the token lands in React state rather than a hidden
 * form field. The script is loaded once per page; the widget is rendered once per mount and
 * removed with it, so switching between login and signup does not stack two.
 */
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string
      reset: (id?: string) => void
      remove: (id: string) => void
    }
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading: Promise<void> | null = null
function load(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  loading ??= new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = SCRIPT; el.async = true; el.defer = true
    el.onload = () => resolve()
    el.onerror = () => { loading = null; reject(new Error('turnstile failed to load')) }
    document.head.appendChild(el)
  })
  return loading
}

export function Turnstile({ siteKey, onToken, resetKey = 0 }: {
  siteKey: string
  /** A fresh token, or '' when the previous one expired or errored. */
  onToken: (token: string) => void
  /** Bump to force a new challenge — after a failed submit, whose token the server has consumed. */
  resetKey?: number
}) {
  const host = useRef<HTMLDivElement>(null)
  const widget = useRef<string | null>(null)
  const emit = useRef(onToken); emit.current = onToken

  useEffect(() => {
    let alive = true
    load().then(() => {
      if (!alive || !host.current || !window.turnstile) return
      widget.current = window.turnstile.render(host.current, {
        sitekey: siteKey,
        theme: isDark(readTheme(), matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light',
        callback: (token: string) => emit.current(token),
        'expired-callback': () => emit.current(''),
        'error-callback': () => emit.current(''),
      })
    }).catch(() => { /* no widget: the submit stays disabled and the message under it says why */ })
    return () => {
      alive = false
      if (widget.current && window.turnstile) { try { window.turnstile.remove(widget.current) } catch { /* already gone */ } }
      widget.current = null
    }
  }, [siteKey])

  useEffect(() => {
    if (resetKey && widget.current && window.turnstile) { emit.current(''); window.turnstile.reset(widget.current) }
  }, [resetKey])

  return <div ref={host} className="min-h-[65px]" />
}
