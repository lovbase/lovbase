import { describe, expect, test } from 'bun:test'
import { nextWidth } from '../src/lib/use-resizable'

const opts = { min: 320, max: 720, side: 'right' as const }
const left = { ...opts, side: 'left' as const }

// The sign is the whole of this function, and it is the easy thing to get backwards. A panel docked
// right grows when the pointer moves left, because the edge being dragged is its leading one.

describe('nextWidth', () => {
  test('a right-docked panel grows as the pointer moves left', () => {
    expect(nextWidth(400, 1000, 940, opts)).toBe(460)
  })

  test('and shrinks as the pointer moves right', () => {
    expect(nextWidth(400, 1000, 1060, opts)).toBe(340)
  })

  test('a left-docked panel is the other way round', () => {
    expect(nextWidth(400, 1000, 1060, left)).toBe(460)
    expect(nextWidth(400, 1000, 940, left)).toBe(340)
  })

  test('not moving does not resize', () => {
    expect(nextWidth(400, 1000, 1000, opts)).toBe(400)
  })

  test('a drag past a limit parks at the limit instead of running away', () => {
    expect(nextWidth(400, 1000, 0, opts)).toBe(720)
    expect(nextWidth(400, 1000, 9000, opts)).toBe(320)
    expect(nextWidth(400, 1000, 9000, left)).toBe(720)
  })

  test('the limits themselves are reachable', () => {
    expect(nextWidth(400, 1000, 1000 - 320, opts)).toBe(720)
    expect(nextWidth(400, 1000, 1000 + 80, opts)).toBe(320)
  })
})
