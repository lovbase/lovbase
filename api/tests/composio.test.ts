import { describe, expect, test } from 'bun:test'
import { ConfigService } from '../src/config/config.service'
import { ComposioService } from '../src/modules/integrations/composio.service'

const spreadsheetId = '1abcdefghijklmnopqrstuvwxyz012345'
function fixture(options: { active?: boolean; fail?: boolean; huge?: boolean } = {}) {
  const calls: { slug: string; args: Record<string, any>; options: unknown }[] = []
  let sessionConfig: any, sessions = 0, deleted = 0, authOptions: any
  const client = {
    authConfigs: { create: async (_toolkit: string, config: unknown) => { authOptions = config; return { id: 'auth' } } },
    connectedAccounts: { list: async (args: any) => {
      expect(args.userIds).toEqual(['user-a'])
      expect(args.authConfigIds).toEqual(['auth'])
      return { items: [{ id: 'account', status: options.active === false ? 'REVOKED' : 'ACTIVE', isDisabled: false, authConfig: { isDisabled: false } }] }
    } },
    create: async (userId: string, config: unknown) => {
      expect(userId).toBe('user-a'); sessions++; sessionConfig = config
      return {
        execute: async (slug: string, args: Record<string, any>, executionOptions: unknown) => {
          calls.push({ slug, args, options: executionOptions })
          const data = slug === 'GOOGLESHEETS_GET_SPREADSHEET_INFO'
            ? { spreadsheetId, properties: { title: 'Book' }, sheets: [
              { properties: { sheetId: 7, title: "客户's", gridProperties: { rowCount: 1000, columnCount: 3 } } },
              { properties: { sheetId: 9, title: 'Another', gridProperties: { rowCount: 10, columnCount: 2 } } },
            ] }
            : { valueRanges: [{ values: calls.filter(c => c.slug === 'GOOGLESHEETS_BATCH_GET').length === 1
              ? [['Name', 'Amount'], [options.huge ? 'x'.repeat(10 * 1024 * 1024) : 'first', 3]] : [['last', 5]] }] }
          return { data, resultType: options.fail ? 'failed' : 'completed', error: null }
        },
        delete: async () => { deleted++ },
      }
    },
  }
  const service = new ComposioService(ConfigService.of({ COMPOSIO_API_KEY: 'test-only' }))
  Object.assign(service, { instance: client })
  return { service, calls, state: () => ({ sessionConfig, sessions, deleted, authOptions }) }
}

describe('Composio session boundary', () => {
  test('sessions pin the user, account and read tools with helper execution disabled', async () => {
    const { service, state } = fixture()
    const info = await service.info('user-a','account','auth',spreadsheetId)
    expect(info.sheets.map(s => s.id)).toEqual([7,9])
    expect(state().sessionConfig).toMatchObject({
      toolkits: ['googlesheets'], connectedAccounts: { googlesheets: 'account' },
      manageConnections: false, sandbox: { enable: false },
      tools: { googlesheets: ['GOOGLESHEETS_GET_SPREADSHEET_INFO','GOOGLESHEETS_BATCH_GET'] },
    })
    expect(state().deleted).toBe(1)
  })
  test('managed authorization requests only Sheets readonly scope', async () => {
    const { service, state } = fixture()
    await service.createAuthConfig()
    expect(state().authOptions.credentials.scopes).toBe('https://www.googleapis.com/auth/spreadsheets.readonly')
  })
  test('revoked authorization fails before creating an execution session', async () => {
    const { service, state } = fixture({ active: false })
    await expect(service.info('user-a','account','auth',spreadsheetId)).rejects.toThrow('no longer active')
    expect(state().sessions).toBe(0)
  })
  test('paged ranges preserve row numbers across trailing blanks and use calculated values', async () => {
    const { service, calls } = fixture()
    const { snapshot } = await service.read('user-a','account','auth',{ url: spreadsheetId, sheetId: 7, headerRow: 1, range: '' })
    expect(snapshot.rows).toEqual([['first',3],['last',5]])
    expect(snapshot.rowNumbers).toEqual([2,501])
    const reads = calls.filter(c => c.slug === 'GOOGLESHEETS_BATCH_GET')
    expect(reads.map(c => c.args.ranges[0])).toEqual(["'客户''s'!A1:C500", "'客户''s'!A501:C1000"])
    expect(reads[0].args.valueRenderOption).toBe('UNFORMATTED_VALUE')
    expect(reads[0].args.dateTimeRenderOption).toBe('FORMATTED_STRING')
    expect(reads[0].options).toEqual({ account: 'account' })
  })
  test('failed results with no error text and oversized payloads are not treated as success', async () => {
    const failure = fixture({ fail: true })
    await expect(failure.service.info('user-a','account','auth',spreadsheetId)).rejects.toThrow('could not be read')
    expect(failure.state().deleted).toBe(1)
    const large = fixture({ huge: true })
    await expect(large.service.read('user-a','account','auth',{ url: spreadsheetId, sheetId: 7, headerRow: 1, range: '' })).rejects.toThrow('10 MiB')
    expect(large.state().deleted).toBe(1)
  })
  test('feature remains unavailable without a platform key', async () => {
    const service = new ComposioService(ConfigService.of({}))
    expect(service.enabled).toBe(false)
    await expect(service.info('user-a','account','auth',spreadsheetId)).rejects.toThrow('not configured')
  })
})
