import { z } from 'zod'

export const SHEETS_MAX_ROWS = 10_000
export const SHEETS_MAX_BYTES = 10 * 1024 * 1024
export const SheetField = z.object({
  column: z.number().int().min(0).max(999),
  name: z.string().trim().min(1).max(120),
  type: z.enum(['text', 'number', 'boolean', 'date']),
})
export type SheetField = z.infer<typeof SheetField>
export const SheetMapping = z.object({
  tableName: z.string().trim().min(1).max(120),
  fields: z.array(SheetField).min(1).max(1000),
})
export type SheetMapping = z.infer<typeof SheetMapping>
export const SheetSource = z.object({
  connectionId: z.string().min(1).optional(),
  url: z.string().min(1).max(2048),
  sheetId: z.number().int().min(0),
  headerRow: z.number().int().min(1).default(1),
  range: z.string().trim().regex(/^(?:[A-Z]+[1-9]\d*:[A-Z]+[1-9]\d*)?$/).default(''),
})
export type SheetSource = z.infer<typeof SheetSource>
export type SheetCell = string | number | boolean | null
export type SheetSnapshot = { headers: string[]; rows: SheetCell[][]; rowNumbers: number[] }
export type SheetInfo = { connection?: { id: string; label: string }; spreadsheetId: string; title: string; sheets: { id: number; title: string; rows: number; columns: number }[] }
export type SheetPreview = {
  connection?: { id: string; label: string };
  id: string; version: number; appId: string; source: SheetSource; mapping: SheetMapping
  headers: string[]; sample: SheetCell[][]; rowCount: number; errors: string[]
  status: 'preview' | 'queued' | 'imported'; entityId: string | null
  job: { status: string; error: string | null } | null
}
