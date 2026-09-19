export function Logo({ size = 22 }: { size?: number }) {
  // base grid + a heart in one cell: a database with love in it
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <g fill="currentColor" opacity=".92">
        <rect x="2" y="2" width="9" height="9" rx="2.4" />
        <rect x="13" y="2" width="9" height="9" rx="2.4" />
        <rect x="2" y="13" width="9" height="9" rx="2.4" />
      </g>
      <path fill="#f43f5e" d="M17.5 22.1c-2.4-1.9-4.4-3.6-4.4-5.9 0-1.5 1.2-2.7 2.7-2.7.7 0 1.4.4 1.7 1 .3-.6 1-1 1.7-1 1.5 0 2.7 1.2 2.7 2.7 0 2.3-2 4-4.4 5.9z" />
    </svg>
  )
}
