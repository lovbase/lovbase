import { Logo } from './Logo'

// The preview pane spends real time in non-content states: a container cold-starting, a sandbox
// that went to sleep, a project with no schema yet. Each one gets a composed frame rather than a
// spinner or, worse, the sandbox's raw JSON error showing through the iframe.

/** The mark, animated: cells settle in one after another and the heart keeps time. */
export function LogoLoader({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="text-fg-mid">
      <g fill="currentColor">
        <rect x="2" y="2" width="9" height="9" rx="2.4" className="lb-cell" style={{ animationDelay: '0ms' }} />
        <rect x="13" y="2" width="9" height="9" rx="2.4" className="lb-cell" style={{ animationDelay: '160ms' }} />
        <rect x="2" y="13" width="9" height="9" rx="2.4" className="lb-cell" style={{ animationDelay: '320ms' }} />
      </g>
      <path
        fill="#f43f5e"
        className="lb-heart"
        d="M17.5 22.1c-2.4-1.9-4.4-3.6-4.4-5.9 0-1.5 1.2-2.7 2.7-2.7.7 0 1.4.4 1.7 1 .3-.6 1-1 1.7-1 1.5 0 2.7 1.2 2.7 2.7 0 2.3-2 4-4.4 5.9z"
      />
    </svg>
  )
}

/** Shared frame: illustration, one line of what is happening, one line of why, optional action. */
export function PreviewFrame({ art, title, hint, action, error }: {
  art: React.ReactNode; title: string; hint?: string; action?: React.ReactNode; error?: string
}) {
  return (
    <div className="h-full grid place-items-center px-8">
      <div className="flex flex-col items-center text-center max-w-sm">
        <div className="mb-5">{art}</div>
        <p className="text-[14px] font-medium text-fg">{title}</p>
        {hint && <p className="text-[12.5px] text-fg-dim leading-relaxed mt-1.5">{hint}</p>}
        {action && <div className="mt-5">{action}</div>}
        {error && <p className="text-[12px] text-warn mt-4 break-words">{error}</p>}
      </div>
    </div>
  )
}

/** A dormant sandbox: the grid is there, dimmed, waiting to be woken. */
export function SleepingArt() {
  return (
    <div className="relative">
      <Logo size={64} />
      <span className="absolute inset-0 grid place-items-center">
        <span className="block size-16 rounded-2xl bg-panel/70 backdrop-blur-[1px]" />
      </span>
      <span className="absolute -right-1 -top-1 flex gap-0.5 text-fg-dim text-[13px] font-medium">
        <span className="lb-z" style={{ animationDelay: '0ms' }}>z</span>
        <span className="lb-z" style={{ animationDelay: '400ms' }}>z</span>
      </span>
    </div>
  )
}

/** No tables yet: an empty grid, nothing to render. */
export function EmptyArt() {
  return (
    <svg width={64} height={64} viewBox="0 0 24 24" aria-hidden className="text-edge-strong">
      <g fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="2.8" y="2.8" width="7.4" height="7.4" rx="2" />
        <rect x="13.8" y="2.8" width="7.4" height="7.4" rx="2" strokeDasharray="2 2.5" />
        <rect x="2.8" y="13.8" width="7.4" height="7.4" rx="2" strokeDasharray="2 2.5" />
        <rect x="13.8" y="13.8" width="7.4" height="7.4" rx="2" strokeDasharray="2 2.5" />
      </g>
    </svg>
  )
}
