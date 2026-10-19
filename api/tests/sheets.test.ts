import { describe, expect, test } from 'bun:test'
import { bounds, columnName, convertSnapshot, defaultMapping, snapshotOf, spreadsheetId } from '../src/modules/integrations/sheets'

const id = '1abcdefghijklmnopqrstuvwxyz_0123456789'
describe('Google Sheets input and conversion', () => {
  test('only real edit links and IDs are accepted, never arbitrary fetch targets', () => {
    expect(spreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id)
    expect(spreadsheetId(id)).toBe(id)
    for (const value of [`https://evil.test/spreadsheets/d/${id}`, `http://docs.google.com/spreadsheets/d/${id}`, 'http://127.0.0.1', 'https://docs.google.com/spreadsheets/d/e/2PACX-test/pubhtml']) expect(() => spreadsheetId(value)).toThrow()
  })
  test('bounds require explicit complete row ranges and include the chosen header', () => {
    expect(bounds('B3:F10', 4, 100, 26)).toEqual({ startColumn: 1, endColumn: 5, startRow: 4, endRow: 10 })
    expect(columnName(26)).toBe('AA')
    for (const range of ['A:Z', 'A2:F4', 'F1:A9', 'A1:Z10002']) expect(() => bounds(range, 1, 20000, 26)).toThrow()
    expect(() => bounds('', 1, 20000, 26)).toThrow(/10,000/)
  })
  test('blank rows preserve source positions; duplicates and Chinese headers are readable', () => {
    const s = snapshotOf([['客户', '客户', ''], [], ['张三', '李四', 0], [null, null], ['王五', null, false]], 3)
    expect(s.rowNumbers).toEqual([5, 7])
    expect(s.rows).toEqual([['张三', '李四', 0], ['王五', null, false]])
    expect(defaultMapping(s, '客户').fields.map(f => f.name)).toEqual(['客户', '客户 (2)', 'Column C'])
  })
  test('numbers, computed results, booleans and ISO dates infer types; mixed and ambiguous strings stay text', () => {
    const s = snapshotOf([['amount', 'formula result', 'active', 'date', 'mixed', 'locale date', 'postal'], [1, 4, true, '2026-10-14', 12, '10/11/2026', '00123'], [2, 6, false, '2026-10-15', 'none', '10/12/2026', '00001']], 1)
    const m = defaultMapping(s, 'Data')
    expect(m.fields.map(f => f.type)).toEqual(['number', 'number', 'boolean', 'date', 'text', 'text', 'text'])
    expect(convertSnapshot(s, m).rows[0]).toEqual([1, 4, true, '2026-10-14T00:00:00Z', '12', '10/11/2026', '00123'])
  })
  test('invalid conversions block confirmation and identify the actual source row', () => {
    const s = snapshotOf([['n', 'date'], [], ['abc', '2026-02-30']], 4)
    const result = convertSnapshot(s, { tableName: 'T', fields: [{ column: 0, name: 'n', type: 'number' }, { column: 1, name: 'date', type: 'date' }] })
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toContain('Row 6')
    expect(result.errors[1]).toContain('2026-02-30')
  })
  test('duplicate fields and out of bounds mappings fail, while omissions work', () => {
    const s = snapshotOf([['a', 'b'], [1, 2]], 1)
    const field = { column: 0, name: 'A', type: 'number' as const }
    expect(convertSnapshot(s, { tableName: 'T', fields: [field, field] }).errors).toHaveLength(2)
    expect(convertSnapshot(s, { tableName: 'T', fields: [{ ...field, column: 8 }] }).errors).toContain('Unknown source column.')
    expect(convertSnapshot(s, { tableName: 'T', fields: [field] }).rows).toEqual([[1]])
  })
  test('oversized snapshots and empty sheets are rejected instead of truncated', () => {
    expect(() => snapshotOf([['n'], ...Array.from({ length: 10001 }, () => [1])], 1)).toThrow(/10,000/)
    expect(() => snapshotOf([['n'], ['x'.repeat(10 * 1024 * 1024)]], 1)).toThrow(/10 MiB/)
    expect(() => snapshotOf([['header'], []], 1)).toThrow(/no data/)
  })
})
