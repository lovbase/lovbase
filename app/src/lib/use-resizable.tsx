import { useCallback, useRef, useState } from 'react'

/**
 * Where a drag puts the edge.
 *
 * The sign is the whole of it, and it is the easy thing to get backwards: a panel on the left grows
 * as the pointer moves right, a panel on the right grows as it moves *left*, because the edge being
 * dragged is its leading one. Clamped so a drag past either limit parks at the limit rather than
 * running away with the layout.
 */
export function nextWidth(
  startWidth: number, startX: number, x: number,
  { min, max, side }: { min: number; max: number; side: 'left' | 'right' },
): number {
  const delta = side === 'left' ? x - startX : startX - x
  return Math.min(max, Math.max(min, startWidth + delta))
}

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
    setWidth(nextWidth(start.current.w, start.current.x, e.clientX, { min, max, side }))
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
    className: `group/handle relative shrink-0 w-3 -mx-1.5 cursor-col-resize z-10 select-none touch-none ${dragging ? 'is-dragging' : ''}`,
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
    try {
      if (w === initial) localStorage.removeItem(k)
      else localStorage.setItem(k, String(w))
    } catch { /* private mode */ }
  })
}

/**
 * Three states, the way an editor does it: a resting mark, a line under the cursor, a lit line
 * while dragging.
 *
 * It used to draw nothing at rest, on the grounds that the panels either side had their own
 * borders and a divider would be a second line on top of the first. That stopped being true when
 * the chat became a rail on the page ground: there is no line there any more, so the gap read as
 * empty space and nobody could tell it was a thing you could pull. The resting mark is a short
 * pill rather than a full-height rule — enough to say "grab here", not enough to fence the panels
 * off from each other.
 */
export function ResizeHandle(props: ReturnType<typeof useResizable>['handleProps']) {
  const dragging = props.className.includes('is-dragging')
  return (
    <div {...props}>
      {/* full-height line: only once the cursor is on it, or while dragging */}
      <div
        className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-px transition-colors duration-150
                    ${dragging ? 'bg-accent' : 'bg-transparent group-hover/handle:bg-edge-strong'}`}
      />
      {/* the resting mark, which grows into a grip under the cursor */}
      <div
        className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[3px] rounded-full
                    transition-all duration-150
                    ${dragging ? 'h-10 bg-accent' : 'h-6 bg-edge-strong group-hover/handle:h-10 group-hover/handle:bg-fg-dim'}`}
      />
    </div>
  )
}
