import type { ReactNode } from 'react'

/**
 * The settings dialog's building blocks. No boxes: a group is a heading over rows split by
 * hairlines, the way a settings sheet reads when there is little to say on each line.
 */
export function Group({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-9 last:mb-0">
      {title && <h3 className="text-[14px] font-medium text-fg pb-2 border-b border-edge">{title}</h3>}
      <div className="divide-y divide-edge">{children}</div>
    </section>
  )
}

export function Item({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5 min-h-[56px]">
      <div className="min-w-0">
        <p className="text-[14px] text-fg">{title}</p>
        {hint && <p className="text-[13px] leading-5 text-fg-dim mt-0.5">{hint}</p>}
      </div>
      {children && <div className="shrink-0 text-[14px] text-fg-mid">{children}</div>}
    </div>
  )
}
