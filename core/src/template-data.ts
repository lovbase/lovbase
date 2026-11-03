/**
 * The contract every SQL-backed template shares. Such a template has no endpoint of its own: a
 * copy reads and writes through the workspace SQL API (one statement per write, with database
 * triggers doing the follow-on bookkeeping), and the gallery preview reads the demo's tables
 * through TemplatesService.readTables. Both hand the app the same shape: one array of rows per
 * table, numeric columns as numbers and timestamps as ISO strings.
 */
export type Cell = string | number | boolean | null
export type TemplateRows = { readOnly: boolean; [table: string]: boolean | Record<string, Cell>[] }
export type DataTemplateClient<Data, Action> = {
  read(): Promise<Data>
  run(action: Action): Promise<void>
}
export type DataTemplateProps<Data = any, Action = any> = {
  client: DataTemplateClient<Data, Action>
  initialData?: Data
  initialLocale?: 'zh' | 'en'
  locale?: 'zh' | 'en'
  onLocaleChange?: (locale: 'zh' | 'en') => void
}
