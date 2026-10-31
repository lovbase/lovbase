import { Logo, LOGO_COLORS, logoCells } from './Logo'

// The preview pane spends real time in non-content states: a container cold-starting, a sandbox
// that went to sleep, a project with no schema yet. Each one gets a composed frame rather than a
// spinner or, worse, the sandbox's raw JSON error showing through the iframe.

/** The mark, building itself: four outlined cells fill in one after another, then start over. */
export function LogoLoader({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      {logoCells((i) => ({ fill: 'none', stroke: LOGO_COLORS[i], strokeWidth: 1.8 }))}
      {logoCells((i) => ({ fill: LOGO_COLORS[i], className: 'lb-fill', style: { animationDelay: `${i * 150}ms` } }))}
    </svg>
  )
}

/** Shared frame: illustration, one line of what is happening, one line of why, optional action. */
export function PreviewFrame({ art, title, action, error }: {
  art: React.ReactNode; title: string; action?: React.ReactNode; error?: string
}) {
  return (
    <div className="relative h-full grid place-items-center px-8">
      <div className="hero-wash absolute inset-0" aria-hidden />
      <div className="relative flex flex-col items-center text-center max-w-sm">
        <div className="mb-5">{art}</div>
        <p className="text-[14px] font-medium text-fg">{title}</p>
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
    <svg width={64} height={64} viewBox="0 0 32 32" aria-hidden className="text-edge-strong">
      {logoCells((i) => ({ fill: 'none', stroke: 'currentColor', strokeWidth: 2.1, strokeDasharray: i ? '2.7 3.3' : undefined }))}
    </svg>
  )
}
