/**
 * A person's avatar, drawn rather than fetched.
 *
 * GitHub's rule: hash the identity, lay the low bits out as a 5×5 grid mirrored down the middle,
 * and take the colour from the high bits. Symmetry is what keeps a random bit pattern looking
 * deliberate. Drawn inline as SVG, so it costs no request, renders on the server, and cannot
 * arrive late and shift the layout — which matters here because these sit in a list of cards.
 *
 * The letter form stays for when there is nothing stable to hash.
 */

/** FNV-1a. Not a cryptographic hash and does not need to be — it needs to be the same everywhere. */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** The 15 cells of the left half and centre column, as [col, row] pairs that are on. */
export function identiconCells(seed: string): [number, number][] {
  const h = hash(seed)
  // A second round for the cells the first one's 32 bits cannot cover.
  const h2 = hash(`${seed}#${h}`)
  const bits = (h & 0xffff) | ((h2 & 0xffff) << 16)
  const on: [number, number][] = []
  for (let i = 0; i < 15; i++) {
    if (!((bits >>> i) & 1)) continue
    const col = Math.floor(i / 5)
    const row = i % 5
    on.push([col, row])
    if (col < 2) on.push([4 - col, row])
  }
  return on
}

export function identiconHue(seed: string): number {
  return hash(`hue:${seed}`) % 360
}

export function Avatar({ src, seed, name, size = 24, className = '' }: {
  /** A picture the person uploaded. Everything below is what stands in until they do. */
  src?: string | null
  /** Something stable and unique to this person — their id, or their email. */
  seed?: string | null
  /** Used for the letter when there is no seed, and as the accessible label. */
  name?: string | null
  size?: number
  className?: string
}) {
  const label = (name ?? '').trim()
  if (src) {
    return (
      <img src={src} alt={label} width={size} height={size} loading="lazy" decoding="async"
        className={`shrink-0 rounded-md object-cover bg-panel-2 ${className}`} style={{ width: size, height: size }} />
    )
  }
  if (!seed) {
    return (
      <span aria-label={label || undefined}
        className={`shrink-0 grid place-items-center rounded-md bg-fg text-ink font-semibold ${className}`}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}>
        {(label[0] ?? '?').toUpperCase()}
      </span>
    )
  }
  const hue = identiconHue(seed)
  const cells = identiconCells(seed)
  return (
    <svg role="img" aria-label={label || undefined} viewBox="0 0 5 5" shapeRendering="crispEdges"
      className={`shrink-0 rounded-md ${className}`} style={{ width: size, height: size }}>
      <rect width="5" height="5" fill={`hsl(${hue} 22% 93%)`} />
      {cells.map(([c, r]) => <rect key={`${c}-${r}`} x={c} y={r} width="1" height="1" fill={`hsl(${hue} 52% 46%)`} />)}
    </svg>
  )
}
