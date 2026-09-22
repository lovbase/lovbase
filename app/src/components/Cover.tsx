import { useState } from 'react'
import { MiniApp } from './MiniApp'

/**
 * A project's picture: a screenshot of the built or published app when there is one, the drawn
 * wireframe until then. The fallback is also the error path — a cover can 404 while a publish is
 * still being photographed, or after storage has been swept — and a broken image icon would be
 * worse than the wireframe it replaced. `className` shapes both, so a card and a palette preview
 * can each ask for their own size and get the same thing either way.
 */
export function Cover({ src, name, tables, className = 'h-32 w-full rounded-xl border border-edge' }: {
  src: string | null | undefined; name: string; tables: string[]; className?: string
}) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return <MiniApp name={name} tables={tables} className={className} />
  return (
    <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)}
      // The markup is server-rendered, so an image can fail before React is anywhere near it and
      // `onError` never fires — which left a broken-image glyph where the wireframe should be.
      // A loaded-but-zero-width image is one that already failed.
      ref={(el) => { if (el?.complete && el.naturalWidth === 0) setFailed(true) }}
      className={`${className} bg-panel-2 object-cover object-top`} />
  )
}
