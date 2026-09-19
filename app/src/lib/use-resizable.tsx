import { useCallback, useEffect, useRef, useState } from 'react'

/** Drag-to-resize width for a panel; remembered per browser under `key`. */
export function useResizable(key: string, initial: number, min: number, max: number, side: 'left' | 'right' = 'left') {
  const [width, setWidth] = useState(initial)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; w: number } | null>(null)
  useEffect(() => { try { const v = Number(localStorage.getItem(`lovbase-w-${key}`)); if (v >= min && v <= max) setWidth(v) } catch {} }, [key])

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
    setWidth((w) => { try { localStorage.setItem(`lovbase-w-${key}`, String(w)) } catch {}; return w })
  }, [key])

  /** Props for the handle element (a thin vertical strip on the panel's edge). */
  const handleProps = {
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
    onDoubleClick: () => { setWidth(initial); try { localStorage.removeItem(`lovbase-w-${key}`) } catch {} },
    role: 'separator' as const, 'aria-orientation': 'vertical' as const, title: '拖动调整宽度,双击恢复',
    className: `group/handle relative shrink-0 w-1 -mx-0.5 cursor-col-resize z-10 select-none touch-none ${dragging ? 'is-dragging' : ''}`,
  }
  return { width, dragging, handleProps }
}

export function ResizeHandle(props: ReturnType<typeof useResizable>['handleProps']) {
  return (
    <div {...props}>
      <div className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-edge transition-colors group-hover/handle:bg-edge-strong ${props.className.includes('is-dragging') ? 'bg-fg/40' : ''}`} />
    </div>
  )
}
