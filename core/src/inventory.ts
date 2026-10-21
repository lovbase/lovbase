/** Shared by the original template, its editable copies and the platform's inventory API. */
export type Locale = 'zh' | 'en'
export type Row = {
  id: string
  created_at?: string
  [key: string]: string | number | boolean | null | undefined
}
export const tables = [
  'categories',
  'suppliers',
  'locations',
  'products',
  'balances',
  'movements',
  'orders',
  'order_items',
] as const
export type Table = (typeof tables)[number]
export type InventoryData = Record<Table, Row[]> & { readOnly: boolean }
export type Command = { action: string; requestId: string; [key: string]: unknown }
export type InventoryClient = {
  read(): Promise<InventoryData>
  command(command: Command): Promise<unknown>
}
export const displayName = (row: Row | undefined, locale: Locale) =>
  String(row?.[locale === 'en' ? 'name_en' : 'name'] || row?.name || '—')
export const quantity = (data: InventoryData, productId: string, locationId?: string) =>
  data.balances
    .filter((b) => b.product_id === productId && (!locationId || b.location_id === locationId))
    .reduce((total, b) => total + Number(b.quantity), 0)
export const stockStatus = (stock: number, threshold: number) =>
  stock === 0 ? 'out' : stock <= threshold ? 'low' : 'in'
export function suggestion(data: InventoryData, product: Row, now = Date.now()) {
  const stock = quantity(data, product.id)
  const daily =
    data.movements
      .filter(
        (m) =>
          m.product_id === product.id &&
          m.kind === 'shipped' &&
          Date.parse(String(m.created_at)) >= now - 30 * 86400000,
      )
      .reduce((s, m) => s + Number(m.quantity), 0) / 30
  const supplier = data.suppliers.find((s) => s.id === product.supplier_id)
  const pending = new Set(
    data.orders.filter((o) => o.status === 'submitted' || o.status === 'partial').map((o) => o.id),
  )
  const inTransit = data.order_items
    .filter((i) => i.product_id === product.id && pending.has(String(i.order_id)))
    .reduce((s, i) => s + Number(i.quantity) - Number(i.received), 0)
  const threshold = Number(product.reorder_point)
  const target =
    daily > 0 ? Math.max(threshold, Math.ceil(daily * (Number(supplier?.lead_days || 0) + 7))) : threshold
  const needed =
    stock + inTransit <= target
      ? Math.max(0, Math.max(target - stock - inTransit, Number(product.reorder_quantity)))
      : 0
  return { stock, daily, inTransit, target, needed, days: daily ? stock / daily : null }
}

export function csvString(rows: unknown[][]): string {
  return (
    '\ufeff' +
    rows
      .map((row) =>
        row
          .map((v) => {
            let s = String(v ?? '')
            if (/^[=+@\-\t\r]/.test(s)) s = "'" + s
            return '"' + s.replaceAll('"', '""') + '"'
          })
          .join(','),
      )
      .join('\r\n')
  )
}

/** RFC-style quoted fields, including embedded commas/newlines; no spreadsheet execution. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [],
    field = '',
    quoted = false
  const input = text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n')
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c === '"') {
      if (quoted && input[i + 1] === '"') {
        field += '"'
        i++
      } else if (!field || quoted) quoted = !quoted
      else throw new Error('csv_invalid')
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field)
      field = ''
      if (c === '\n') {
        if (row.some(Boolean)) rows.push(row)
        row = []
      }
    } else field += c
  }
  if (quoted) throw new Error('csv_invalid')
  row.push(field)
  if (row.some(Boolean)) rows.push(row)
  return rows
}
