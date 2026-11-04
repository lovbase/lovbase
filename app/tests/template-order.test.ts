import { describe, expect, test } from 'bun:test'
import { byPosition } from '../src/lib/template-order'

describe('gallery order', () => {
  test('positioned first in their order, the rest after in the order they came', () => {
    const items = ['a', 'b', 'c', 'd', 'e']
    expect(byPosition(items, (x) => x, { d: 1, b: 2 })).toEqual(['d', 'b', 'a', 'c', 'e'])
  })

  test('no positions keeps the order it was given', () => {
    expect(byPosition(['b', 'a'], (x) => x, {})).toEqual(['b', 'a'])
  })
})
