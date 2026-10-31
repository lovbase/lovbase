import type { SVGAttributes } from 'react'

/** Square, circle, leaf, square: the four cells of the mark, in reading order. */
export const LOGO_COLORS = ['#2f6df6', '#ff6a55', '#7c5cff', '#9ec5ff'] as const

/**
 * The mark's four cells on a 32-unit canvas, each painted by `paint(i)`. Different shapes in one
 * grid: a table holding different kinds of data. `compact` closes the gap so the cells still read
 * as one block at favicon sizes, where a 2-unit gap blurs into the shapes.
 */
export function logoCells(paint: (i: number) => SVGAttributes<SVGElement>, compact = false) {
  const s = compact ? 12.75 : 12
  const gap = compact ? 1 : 2
  const a = (32 - s * 2 - gap) / 2
  const b = a + s + gap
  const r = s / 2
  return [
    <rect key={0} x={a} y={a} width={s} height={s} rx={3} {...paint(0)} />,
    <circle key={1} cx={b + r} cy={a + r} r={r} {...paint(1)} />,
    <path key={2} d={`M${a + r} ${b}H${a + s}V${b + r}A${r} ${r} 0 0 1 ${a + r} ${b + s}H${a}V${b + r}A${r} ${r} 0 0 1 ${a + r} ${b}Z`} {...paint(2)} />,
    <rect key={3} x={b} y={b} width={s} height={s} rx={3} {...paint(3)} />,
  ]
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      {logoCells((i) => ({ fill: LOGO_COLORS[i] }), size <= 20)}
    </svg>
  )
}
