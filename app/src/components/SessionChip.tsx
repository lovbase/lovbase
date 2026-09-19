import { Link } from '@tanstack/react-router'
import { signOut, useSession } from '../lib/auth-client'
import { resetIdentity } from '../lib/posthog'

export function SessionChip() {
  const { data: session, isPending } = useSession()
  if (isPending) return <span className="w-14" />
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
