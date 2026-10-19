import { Injectable, Logger } from '@nestjs/common'
import { Composio, SessionPreset } from '@composio/core'
import { z } from 'zod'
import { ConfigService } from '../../config/config.service'
import { DomainError } from '../../common/errors'
import type { SheetInfo, SheetSource } from '@lovbase/core/sheets'
import { SHEETS_MAX_BYTES } from '@lovbase/core/sheets'
import { bounds, columnName, snapshotOf, spreadsheetId } from './sheets'

const READ_TOOLS = ['GOOGLESHEETS_GET_SPREADSHEET_INFO', 'GOOGLESHEETS_BATCH_GET']
const metadata = z.object({ spreadsheetId: z.string(), properties: z.object({ title: z.string() }), sheets: z.array(z.object({ properties: z.object({
  sheetId: z.number(), title: z.string(), gridProperties: z.object({ rowCount: z.number().int().positive(), columnCount: z.number().int().positive() }).optional(),
}) })) })
const valuesResponse = z.object({ valueRanges: z.array(z.object({ values: z.array(z.array(z.unknown())).optional() })).length(1) })
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
// Only diagnostic identifiers are retained; provider payloads can contain credentials or sheet data.
const executionError = z.object({
  status: z.number().optional(), request_id: requestId.optional(),
  error: z.object({ error: z.object({ code: z.number().optional(), request_id: requestId.optional() }).optional() }).optional(),
})

/** Only this adapter knows Composio's API. No credential-shaped objects leave it. */
@Injectable()
export class ComposioService {
  private readonly logger = new Logger(ComposioService.name)
  private instance?: Composio
  constructor(private readonly cfg: ConfigService) {}
  get enabled() { return !!this.cfg.env.COMPOSIO_API_KEY }
  private get client() {
    if (!this.enabled) throw new DomainError('Google Sheets integration is not configured.')
    return this.instance ??= new Composio({ apiKey: this.cfg.env.COMPOSIO_API_KEY, allowTracking: false })
  }
  async createAuthConfig() {
    const result = await this.client.authConfigs.create('googlesheets', {
      type: 'use_composio_managed_auth', name: 'Lovbase Sheets read only',
      credentials: { scopes: 'https://www.googleapis.com/auth/spreadsheets.readonly' },
    })
    return result.id
  }
  async authorize(userId: string, authConfigId: string, callbackUrl: string) {
    const session = await this.client.create(userId, {
      toolkits: ['googlesheets'], authConfigs: { googlesheets: authConfigId }, sandbox: { enable: false },
      tools: { googlesheets: READ_TOOLS },
    })
    const request = await session.authorize('googlesheets', { callbackUrl })
    if (!request.redirectUrl) throw new DomainError('Could not start Google authorization. Try again.')
    return { accountId: request.id, url: request.redirectUrl }
  }
  async account(userId: string, accountId: string, authConfigId: string) {
    // SDK retrieval omits userId. Use the user-filtered listing to prove remote ownership too.
    let cursor: string | undefined
    do {
      const page = await this.client.connectedAccounts.list({ userIds: [userId], authConfigIds: [authConfigId], toolkitSlugs: ['googlesheets'], limit: 100, cursor })
      const account = page.items.find(a => a.id === accountId)
      if (account) return { active: account.status === 'ACTIVE' && !account.isDisabled && !account.authConfig.isDisabled, label: account.alias || 'Google Sheets', status: account.status }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return { active: false, label: 'Google Sheets', status: 'NOT_FOUND' }
  }
  async disconnect(accountId: string) { await this.client.connectedAccounts.delete(accountId) }

  private async withSession<T>(userId: string, accountId: string, authConfigId: string, fn: (execute: (slug: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<T>): Promise<T> {
    const account = await this.account(userId, accountId, authConfigId)
    if (!account.active) throw new DomainError('Google authorization is no longer active. Reconnect in Connections.')
    const session = await this.client.create(userId, {
      toolkits: ['googlesheets'], tools: { googlesheets: READ_TOOLS },
      authConfigs: { googlesheets: authConfigId }, connectedAccounts: { googlesheets: accountId },
      sessionPreset: SessionPreset.DIRECT_TOOLS, manageConnections: false, sandbox: { enable: false },
    })
    try {
      return await fn(async (slug, args) => {
        if (!READ_TOOLS.includes(slug)) throw new DomainError('Unsupported Sheets operation.')
        // Only idempotent reads retry; credentials and provider response bodies never enter logs.
        for (let attempt = 0; ; attempt++) {
          try {
            // The session already pins this user's connection. The per-call `account` option
            // is rejected by projects where Composio multi-account selection is not enabled.
            const result = await session.execute(slug, args)
            if (result.resultType !== 'completed') throw new DomainError('Google Sheets could not be read. Check access to this file, then retry.')
            return result.data
          } catch (error) {
            const status = (error as { status?: number }).status
            if (attempt < 2 && (status === 429 || status === 502 || status === 503)) {
              await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt)); continue
            }
            if (error instanceof DomainError) throw error
            const diagnostic = executionError.safeParse(error)
            const details = diagnostic.success ? diagnostic.data : undefined
            const reference = details?.error?.error?.request_id ?? details?.request_id
            this.logger.warn(JSON.stringify({ event: 'sheets_execution_failed', tool: slug,
              status: details?.status, code: details?.error?.error?.code, requestId: reference }))
            const message = status === 401 ? 'Google authorization could not be validated. Reconnect Google Sheets and retry.'
              : status === 403 ? 'Google Sheets access was denied. Check that the connected account can read this spreadsheet.'
              : 'Google Sheets could not complete the request. Please retry or contact support.'
            throw new DomainError(message + (reference ? ` Reference: ${reference}` : ''))
          }
        }
      })
    } finally { await session.delete().catch(() => {}) }
  }
  private async infoFrom(execute: (slug: string, args: Record<string, unknown>) => Promise<unknown>, url: string): Promise<SheetInfo> {
    const data = metadata.parse(await execute(READ_TOOLS[0], {
      spreadsheet_id: spreadsheetId(url), fields: 'spreadsheetId,properties.title,sheets.properties(sheetId,title,gridProperties)',
    }))
    return { spreadsheetId: data.spreadsheetId, title: data.properties.title, sheets: data.sheets.filter(s => s.properties.gridProperties).map(({ properties: p }) => ({
      id: p.sheetId, title: p.title, rows: p.gridProperties!.rowCount, columns: p.gridProperties!.columnCount,
    })) }
  }
  info(userId: string, accountId: string, authConfigId: string, url: string) {
    spreadsheetId(url)
    return this.withSession(userId, accountId, authConfigId, execute => this.infoFrom(execute, url))
  }
  read(userId: string, accountId: string, authConfigId: string, source: SheetSource) {
    return this.withSession(userId, accountId, authConfigId, async execute => {
      const info = await this.infoFrom(execute, source.url)
      const sheet = info.sheets.find(s => s.id === source.sheetId)
      if (!sheet) throw new DomainError('This worksheet no longer exists.')
      const b = bounds(source.range, source.headerRow, sheet.rows, sheet.columns)
      const matrix: unknown[][] = []
      let bytes = 2
      for (let start = b.startRow; start <= b.endRow; start += 500) {
        const end = Math.min(start + 499, b.endRow)
        const range = `'${sheet.title.replaceAll("'", "''")}'!${columnName(b.startColumn)}${start}:${columnName(b.endColumn)}${end}`
        const data = valuesResponse.parse(await execute(READ_TOOLS[1], {
          spreadsheet_id: info.spreadsheetId, ranges: [range], majorDimension: 'ROWS',
          valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING',
        }))
        const rows = data.valueRanges[0].values ?? []
        bytes += Buffer.byteLength(JSON.stringify(rows))
        if (bytes > SHEETS_MAX_BYTES) throw new DomainError('The snapshot exceeds 10 MiB. Select a smaller range.')
        if (rows.length > end - start + 1 || rows.some(r => r.length > b.endColumn - b.startColumn + 1)) throw new DomainError('Unexpected Sheets range response.')
        // Google trims trailing blank rows. Restore their positions before reading the next page.
        for (let i = 0; i <= end - start; i++) matrix.push(rows[i] ?? [])
      }
      return { snapshot: snapshotOf(matrix, b.startRow), title: sheet.title }
    })
  }
}
