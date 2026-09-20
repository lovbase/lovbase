import { useCallback, useRef, useState } from 'react'

/** Drag-to-resize width for a panel. Persisting is the caller's job — see lib/layout-prefs.ts. */
export function useResizable(initial: number, min: number, max: number, side: 'left' | 'right' = 'left', onCommit?: (w: number) => void) {
  const [width, setWidth] = useState(initial)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; w: number } | null>(null)
  // No effect reads a stored width here: `initial` already carries it, from a cookie the server
  // could read. Correcting the width after hydration is what made the panel jump on every refresh.

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    start.current = { x: e.clientX, w: width }
    setDragging(true)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [width])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!start.current) return
    const delta = side === 'left' ? e.clientX - start.current.x : start.current.x - e.clientX
    setWidth(Math.min(max, Math.max(min, start.current.w + delta)))
  }, [min, max, side])
  const onPointerUp = useCallback(() => {
    if (!start.current) return
    start.current = null
    setDragging(false)
    setWidth((w) => { onCommit?.(w); return w })
  }, [onCommit])

  /** Props for the handle element (a thin vertical strip on the panel's edge). */
  const handleProps = {
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
    onDoubleClick: () => { setWidth(initial); onCommit?.(initial) },
    role: 'separator' as const, 'aria-orientation': 'vertical' as const, title: '拖动调整宽度,双击恢复',
    className: `group/handle relative shrink-0 w-2 -mx-1 cursor-col-resize z-10 select-none touch-none ${dragging ? 'is-dragging' : ''}`,
  }
  return { width, dragging, handleProps }
}

/**
 * The same, for a panel that only ever mounts on the client — a tab someone has to click into.
 * There is no server pass to disagree with, so the stored width can be read during render and the
 * panel appears at the right size. Anything present in the first paint cannot use this: its width
 * has to reach the server, which means the cookie in lib/layout-prefs.ts.
 */
export function useStoredResizable(key: string, initial: number, min: number, max: number, side: 'left' | 'right' = 'left') {
  const k = `lovbase-w-${key}`
  const [start] = useState(() => {
    try { const v = Number(localStorage.getItem(k)); return v >= min && v <= max ? v : initial } catch { return initial }
  })
  return useResizable(start, min, max, side, (w) => {
    try { w === initial ? localStorage.removeItem(k) : localStorage.setItem(k, String(w)) } catch { /* private mode */ }
  })
}

/**
 * Three states, the way an editor does it: nothing at rest, a grip under the cursor, a lit line
 * while dragging. The panels already have their own borders, so a permanent divider here was a
 * second line drawn on top of the first — visible weight for something you touch once a session.
 */
export function ResizeHandle(props: ReturnType<typeof useResizable>['handleProps']) {
  const dragging = props.className.includes('is-dragging')
  return (
    <div {...props}>
      <div
        className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-px transition-colors duration-150
                    ${dragging ? 'bg-accent' : 'bg-transparent group-hover/handle:bg-edge-strong'}`}
      />
      <div
        className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-[2px]
                    transition-opacity duration-150 ${dragging ? 'opacity-0' : 'opacity-0 group-hover/handle:opacity-100'}`}
      >
        <span className="size-[2.5px] rounded-full bg-fg-mid" />
        <span className="size-[2.5px] rounded-full bg-fg-mid" />
        <span className="size-[2.5px] rounded-full bg-fg-mid" />
      </div>
    </div>
  )
}
