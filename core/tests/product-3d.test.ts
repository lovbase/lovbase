import { describe, expect, test } from 'bun:test'
import { quoteProduct, type Product, type ProductOption } from '../src/product-3d'
const product: Product = {
  id: 'chair',
  created_at: '',
  model: 'atelier-chair-v1',
  name: '餐椅',
  name_en: 'Chair',
  description: '',
  description_en: '',
  price_cents: 168000,
}
const seat: ProductOption = {
  id: 'seat',
  created_at: '',
  product_id: 'chair',
  part: 'seat',
  name: '椅面',
  name_en: 'Seat',
  color: '#667766',
  roughness: 0.9,
  price_cents: 12000,
  enabled: true,
}
const frame: ProductOption = {
  ...seat,
  id: 'frame',
  part: 'frame',
  price_cents: 24000,
}
const selection = {
  productId: 'chair',
  optionIds: ['seat', 'frame'],
  quantity: 6,
}
describe('3D product pricing', () => {
  test('integer cents, quantity and detached snapshot', () => {
    const q = quoteProduct(product, [seat, frame], selection)
    expect(q.unit_cents).toBe(204000)
    expect(q.total_cents).toBe(1224000)
    expect(q.currency).toBe('CNY')
    q.options[0].color = '#ffffff'
    expect(seat.color).toBe('#667766')
  })
  test.each([0, -1, 1.5, NaN, Infinity, 1001])('rejects invalid quantity %s', (quantity) => {
    expect(() => quoteProduct(product, [seat, frame], { ...selection, quantity })).toThrow(
      'invalid_quantity',
    )
  })
  test('rejects cross-product, missing, duplicate and disabled choices', () => {
    expect(() =>
      quoteProduct(product, [seat, { ...frame, product_id: 'other' }], selection),
    ).toThrow('option_unavailable')
    expect(() => quoteProduct(product, [seat], selection)).toThrow('option_unavailable')
    expect(() =>
      quoteProduct(product, [seat, frame], {
        ...selection,
        optionIds: ['seat', 'seat'],
      }),
    ).toThrow('invalid_options')
    expect(() => quoteProduct(product, [seat, { ...frame, enabled: false }], selection)).toThrow(
      'option_unavailable',
    )
    expect(() => quoteProduct(product, [seat, { ...frame, part: 'seat' }], selection)).toThrow(
      'invalid_options',
    )
  })
  test.each([-1, 1.5, NaN, Infinity, 100000001])('rejects invalid price %s', (price_cents) => {
    expect(() => quoteProduct({ ...product, price_cents }, [seat, frame], selection)).toThrow(
      'invalid_price',
    )
  })
})
