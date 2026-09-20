import { describe, expect, test } from 'bun:test'
import { identiconCells, identiconHue } from '../src/components/Avatar'

// These are drawn on the server and again on the client, and they identify a person across a list
// of cards. Both of those break if the same seed can produce two different pictures.

describe('identicon', () => {
  test('the same seed always draws the same thing', () => {
    expect(identiconCells('a@b.com')).toEqual(identiconCells('a@b.com'))
    expect(identiconHue('a@b.com')).toBe(identiconHue('a@b.com'))
  })

  test('different people look different', () => {
    const a = JSON.stringify(identiconCells('a@b.com'))
    const b = JSON.stringify(identiconCells('c@d.com'))
    expect(a).not.toBe(b)
  })

  test('is mirrored down the middle, which is what stops it looking like noise', () => {
    const cells = identiconCells('someone@example.com')
    const on = new Set(cells.map(([c, r]) => `${c},${r}`))
    for (const [c, r] of cells) expect(on.has(`${4 - c},${r}`)).toBe(true)
  })

  test('stays inside the 5×5 grid', () => {
    for (const seed of ['', 'x', 'a@b.com', '项目', '🙂'])
      for (const [c, r] of identiconCells(seed)) {
        expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThan(5)
        expect(r).toBeGreaterThanOrEqual(0); expect(r).toBeLessThan(5)
      }
  })

  test('never draws the same cell twice, so the centre column is not doubled', () => {
    const cells = identiconCells('centre@example.com')
    expect(new Set(cells.map(String)).size).toBe(cells.length)
  })

  test('hue is a real angle', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const h = identiconHue(seed)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
    }
  })
})
