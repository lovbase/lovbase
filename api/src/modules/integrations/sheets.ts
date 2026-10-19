import { z } from 'zod'
import { SHEETS_MAX_BYTES, SHEETS_MAX_ROWS, type SheetMapping, type SheetSnapshot } from '@lovbase/core/sheets'
import { DomainError } from '../../common/errors'

export function spreadsheetId(value: string): string {
  if (/^[a-zA-Z0-9_-]{20,}$/.test(value)) return value
  try {
    const url = new URL(value)
    const id = url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})(?:\/|$)/)?.[1]
    if (url.protocol === 'https:' && url.hostname === 'docs.google.com' && id) return id
  } catch { /* report the same validation error for all invalid URLs */ }
  throw new DomainError('Use a Google Sheets edit link or spreadsheet ID, not a published link.')
}

export function columnName(n: number): string {
  let out = ''
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out
  return out
}
const columnIndex = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
export function bounds(range: string, headerRow: number, rows: number, columns: number) {
  const match = /^([A-Z]+)([1-9]\d*):([A-Z]+)([1-9]\d*)$/.exec(range)
  if (range && !match) throw new DomainError('Use a bounded range, for example A1:F500.')
  const startColumn = match ? columnIndex(match[1]) : 0
  const endColumn = match ? columnIndex(match[3]) : columns - 1
  const startRow = match ? Number(match[2]) : headerRow
  const endRow = match ? Number(match[4]) : rows
  if (startRow > headerRow || headerRow > endRow || startColumn > endColumn || endColumn >= columns || endRow > rows)
    throw new DomainError('The range must contain the header row and be inside the selected worksheet.')
  if (endRow - headerRow > SHEETS_MAX_ROWS || endColumn - startColumn >= 1000)
    throw new DomainError('Select a smaller range: at most 10,000 data rows and 1,000 columns per import.')
  return { startColumn, endColumn, startRow: headerRow, endRow }
}
const cells = z.array(z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])))
const blank = (v: unknown) => v == null || v === ''
export function snapshotOf(values: unknown, firstRow: number): SheetSnapshot {
  const matrix = cells.parse(values)
  if (Buffer.byteLength(JSON.stringify(matrix)) > SHEETS_MAX_BYTES) throw new DomainError('The snapshot exceeds 10 MiB. Select a smaller range.')
  const width = matrix.reduce((n, row) => Math.max(n, row.length), 0)
  if (!width || width > 1000) throw new DomainError('The selected range is empty or has too many columns.')
  const headers = Array.from({ length: width }, (_, i) => String(matrix[0]?.[i] ?? '').trim() || `Column ${columnName(i)}`)
  const rows: SheetSnapshot['rows'] = [], rowNumbers: number[] = []
  matrix.slice(1).forEach((row, i) => {
    if (row.every(blank)) return
    rows.push(Array.from({ length: width }, (_, col) => row[col] ?? null))
    rowNumbers.push(firstRow + i + 1)
  })
  if (rows.length > SHEETS_MAX_ROWS) throw new DomainError('Select at most 10,000 data rows.')
  if (!rows.length) throw new DomainError('The selected range has no data rows below the header.')
  return { headers, rows, rowNumbers }
}

const isoDate = (v: string) => /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(v)
  && !Number.isNaN(Date.parse(v)) && new Date(`${v.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === v.slice(0, 10)
export function defaultMapping(snapshot: SheetSnapshot, tableName: string): SheetMapping {
  const used = new Set<string>()
  return { tableName, fields: snapshot.headers.map((header, column) => {
    const base = header.slice(0, 110)
    let name = base, suffix = 2
    while (used.has(name)) name = `${base} (${suffix++})`
    used.add(name)
    const values = snapshot.rows.map(row => row[column]).filter(v => !blank(v))
    const type = values.length && values.every(v => typeof v === 'number') ? 'number'
      : values.length && values.every(v => typeof v === 'boolean') ? 'boolean'
      : values.length && values.every(v => typeof v === 'string' && isoDate(v)) ? 'date' : 'text'
    return { column, name, type }
  }) }
}

export function convertSnapshot(snapshot: SheetSnapshot, mapping: SheetMapping) {
  const errors: string[] = []
  if (new Set(mapping.fields.map(f => f.column)).size !== mapping.fields.length) errors.push('A source column can only be mapped once.')
  if (new Set(mapping.fields.map(f => f.name)).size !== mapping.fields.length) errors.push('Field names must be unique.')
  if (mapping.fields.some(f => f.column >= snapshot.headers.length)) errors.push('Unknown source column.')
  const rows = snapshot.rows.map((row, index) => mapping.fields.map(field => {
    const value = row[field.column]
    if (blank(value)) return null
    if (field.type === 'text' && !String(value).includes('\u0000')) return String(value)
    if (field.type === 'number' && (typeof value === 'number' || typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) && Number.isFinite(Number(value))) return Number(value)
    if (field.type === 'boolean' && /^(true|false)$/i.test(String(value))) return String(value).toLowerCase() === 'true'
    if (field.type === 'date' && typeof value === 'string' && isoDate(value)) return value.length === 10 ? `${value}T00:00:00Z` : value
    if (errors.length < 30) errors.push(`Row ${snapshot.rowNumbers[index]}, ${field.name}: cannot convert ${JSON.stringify(String(value).slice(0, 80))} to ${field.type}.`)
    return null
  }))
  return { rows, errors }
}
