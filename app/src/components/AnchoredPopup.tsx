import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/** A small menu pinned above its trigger, portalled so no overflow-hidden ancestor can clip it. */
/**
 * A popup anchored above a trigger, rendered into `document.body`.
 *
 * The composer wraps everything in `InputGroup className="overflow-hidden"` (vendored), so an
 * absolutely-positioned menu inside it gets clipped to the input box — which is how the tier list
 * ended up as one half-visible row lying across the placeholder text. Portalling escapes every
 * ancestor's overflow; the position is measured from the trigger each time it opens.
 */
export function AnchoredPopup({ anchorRef, open, onClose, width, children }: {
  anchorRef: React.RefObject<HTMLElement | null>
  open: boolean; onClose: () => void; width: number; children: React.ReactNode
}) {
  const [box, setBox] = useState<{ left: number; bottom: number } | null>(null)

  useEffect(() => {
    if (!open) { setBox(null); return }
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect()
      if (!r) return
      // Keep it on screen when the trigger sits near the right edge.
      setBox({ left: Math.min(r.left, window.innerWidth - width - 8), bottom: window.innerHeight - r.top + 6 })
    }
    place()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, width, anchorRef, onClose])

  if (!open || !box || typeof document === 'undefined') return null
  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} />
      <div style={{ left: box.left, bottom: box.bottom, width }}
        className="fixed z-[61] rounded-lg border border-edge bg-panel shadow-xl overflow-hidden">
        {children}
      </div>
    </>,
    document.body,
  )
}
