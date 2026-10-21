import { describe, expect, test } from 'bun:test'
import { csvString, parseCsv, suggestion, stockStatus, type InventoryData } from '../src/inventory'
import { templateReturn } from '../../app/src/lib/auth-return'
describe('inventory calculations and CSV boundaries', () => {
  test('CSV supports quotes, embedded newlines and spreadsheet formula neutralization', () => {
    const rows = [
      ['name', 'note'],
      ['Pen, blue', 'A "quoted"\nvalue'],
    ]
    expect(parseCsv(csvString(rows))).toEqual(rows)
    expect(csvString([['=SUM(A1)', '@CMD', '-1']])).toContain("'=SUM(A1)")
    expect(() => parseCsv('"unfinished')).toThrow('csv_invalid')
  })
  test('reorder uses incoming stock and gracefully handles zero usage', () => {
    const p = { id: 'p', supplier_id: 's', reorder_point: 10, reorder_quantity: 20 }
    const d = {
      products: [p],
      suppliers: [{ id: 's', lead_days: 3 }],
      categories: [],
      locations: [],
      balances: [{ id: 'b', product_id: 'p', quantity: 5 }],
      orders: [],
      order_items: [],
      movements: [],
      readOnly: false,
    } as InventoryData
    expect(suggestion(d, p)).toMatchObject({ needed: 20, daily: 0, days: null })
    d.orders = [{ id: 'o', status: 'submitted' }]
    d.order_items = [{ id: 'i', order_id: 'o', product_id: 'p', quantity: 30, received: 0 }]
    expect(suggestion(d, p).needed).toBe(0)
    d.orders[0].status = 'cancelled'
    expect(suggestion(d, p).needed).toBe(20)
    expect(stockStatus(10, 10)).toBe('low')
    expect(stockStatus(0, 0)).toBe('out')
  })
  test('authentication return cannot become an open redirect', () => {
    for (const bad of [
      'https://evil.invalid',
      '//evil.invalid',
      '/templates?template=unknown',
      '/templates?template=inventory#\n',
    ]) {
      if (bad.includes('unknown') || !bad.startsWith('/templates'))
        expect(templateReturn(bad)).toBeUndefined()
    }
    expect(templateReturn('/templates?template=inventory&remix=1')).toBe(
      '/templates?template=inventory&remix=1',
    )
    expect(templateReturn('/templates?template=inventory&next=https://evil.invalid')).toBe(
      '/templates?template=inventory&remix=1',
    )
  })
})
