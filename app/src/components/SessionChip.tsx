import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { signOut, useSession } from '../lib/auth-client'
import { resetIdentity } from '../lib/posthog'

export function SessionChip() {
  // The session is only known on the client, so the server always renders the placeholder. Without
  // waiting for mount the first client render produces a different *element* — a div where the
  // server put a span — and React cannot patch that: it throws a hydration mismatch and, in dev,
  // prints the whole component tree. Every signed-in page load did it, Vite forwarded each one to
  // the server console, and the dev server eventually died of heap exhaustion with 391k lines of
  // log. `suppressHydrationWarning` does not help here; it does not cover a changed element type.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const { data: session, isPending } = useSession()
  if (!mounted || isPending) return <span className="w-14" />
  if (!session)
    return (
      <Link to="/login"
        className="px-3 py-1.5 text-[12.5px] text-fg-mid border border-edge rounded-lg
                   hover:text-fg hover:border-edge-strong transition-colors">
        登录
      </Link>
    )
  return (
    <div className="flex items-center gap-2.5">
      <span className="size-6 rounded-full bg-panel-2 border border-edge text-fg-mid
                       flex items-center justify-center text-[11px] font-medium select-none">
        {(session.user.name || session.user.email)[0]?.toUpperCase()}
      </span>
      <span className="text-[12.5px] text-fg-mid max-w-28 truncate">{session.user.name || session.user.email}</span>
      <button onClick={() => { resetIdentity(); void signOut().then(() => { location.href = '/login' }) }}
        className="text-[11px] font-mono text-fg-dim hover:text-fg-mid transition-colors cursor-pointer">
        退出
      </button>
    </div>
  )
}
