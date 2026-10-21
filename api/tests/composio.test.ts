import { describe, expect, test } from 'bun:test'
import { ConfigService } from '../src/config/config.service'
import { ComposioService } from '../src/modules/integrations/composio.service'

const spreadsheetId = '1abcdefghijklmnopqrstuvwxyz012345'
function fixture(options: { active?: boolean; fail?: boolean; huge?: boolean; executionError?: unknown } = {}) {
  const calls: { slug: string; args: Record<string, any>; options: unknown }[] = []
  const warnings: string[] = []
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
          // Reproduce the production project's rejection of per-call account selection.
          if (executionOptions !== undefined) throw Object.assign(new Error('Multi-account selection is not enabled'), { status: 400 })
          if (options.executionError) throw options.executionError
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
  Object.assign(service, { instance: client, logger: { warn: (message: string) => warnings.push(message) } })
  return { service, calls, warnings, state: () => ({ sessionConfig, sessions, deleted, authOptions }) }
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
    expect(reads[0].options).toBeUndefined()
  })
  test('execution errors preserve safe request identifiers without logging provider data or claiming revocation', async () => {
    const f = fixture({ executionError: Object.assign(new Error('secret-provider-message'), {
      status: 400, error: { error: { code: 4300, request_id: 'test-request-123', message: 'secret-token' } },
    }) })
    await expect(f.service.info('user-a','account','auth',spreadsheetId)).rejects.toThrow('Reference: test-request-123')
    expect(f.warnings.map(w => JSON.parse(w))).toEqual([{ event: 'sheets_execution_failed', tool: 'GOOGLESHEETS_GET_SPREADSHEET_INFO', status: 400, code: 4300, requestId: 'test-request-123' }])
    expect(f.state().deleted).toBe(1)
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

describe('Composio account management adapter', () => {
  test('catalog preserves pagination, safe fields and dynamic app availability', async () => {
    const service = new ComposioService(ConfigService.of({ COMPOSIO_API_KEY: 'test-only' }))
    Object.assign(service, { instance: { getClient: () => ({ toolkits: { list: async (args: any) => {
      expect(args).toMatchObject({ search: 'mail', cursor: 'page2', sort_by: 'usage' })
      return { items: [{ slug: 'gmail', name: 'Gmail', meta: { logo: 'https://example.test/icon' }, auth_schemes: ['OAUTH2'], composio_managed_auth_schemes: ['OAUTH2'], secret: 'DO-NOT-RETURN' }], next_cursor: 'page3' }
    } } }) } })
    const result = await service.catalog('mail', 'page2')
    expect(result.cursor).toBe('page3')
    expect(result.items[0]?.available).toBe(true)
    expect(JSON.stringify(result)).not.toContain('DO-NOT-RETURN')
  })
  test('credential metadata retains required fields and hides secret defaults and invisible fields', async () => {
    const service = new ComposioService(ConfigService.of({ COMPOSIO_API_KEY: 'test-only' }))
    Object.assign(service, { instance: { toolkits: { get: async () => ({ slug: 'provider', name: 'Provider', meta: {}, authConfigDetails: [{ mode: 'API_KEY', authHintUrl: 'https://example.test/keys', fields: { connectedAccountInitiation: {
      required: [{ name: 'provider_key', displayName: 'Key', description: 'Get a key', type: 'string', isSecret: true, default: 'DO-NOT-RETURN' }, { name: 'tenant', displayName: 'Tenant', description: '', type: 'string', isSecret: false }],
      optional: [{ name: 'hidden', userVisible: false, default: 'DO-NOT-RETURN' }],
    } } }] }) } } })
    const auth = await service.authentication('provider')
    expect(auth.methods[0]?.fields.map(f => f.name)).toEqual(['provider_key', 'tenant'])
    expect(auth.methods[0]?.fields[0]).toMatchObject({ secret: true, required: true })
    expect(auth.methods[0]?.fields[1]?.secret).toBe(false)
    expect(JSON.stringify(auth)).not.toContain('DO-NOT-RETURN')
  })
  test('API keys use exact dynamic field names and redact SDK rejection messages', async () => {
    const service = new ComposioService(ConfigService.of({ COMPOSIO_API_KEY: 'test-only' }))
    let reject = false
    Object.assign(service, { instance: { connectedAccounts: { initiate: async (user: string, auth: string, options: any) => {
      expect(user).toBe('user-a'); expect(auth).toBe('auth-a')
      expect(options.allowMultiple).toBe(true)
      expect(options.config.authScheme).toBe('API_KEY')
      expect(options.config.val.custom_key).toBe('DO-NOT-RETURN')
      expect(options.config.val.tenant).toBe('acme')
      if (reject) throw new Error('DO-NOT-RETURN')
      return { id: 'new-account' }
    } } } })
    expect(await service.connectKey('user-a', 'auth-a', { custom_key: 'DO-NOT-RETURN', tenant: 'acme' })).toBe('new-account')
    reject = true
    await expect(service.connectKey('user-a', 'auth-a', { custom_key: 'DO-NOT-RETURN', tenant: 'acme' })).rejects.toThrow('Check the fields')
  })
  test('identity comes from the provider displayName instead of an alias or credential state', async () => {
    const f = fixture()
    Object.assign(f.service, { instance: { connectedAccounts: { list: async () => ({ items: [{ id: 'account', alias: 'A note', status: 'ACTIVE', isDisabled: false, authConfig: { isDisabled: false }, state: { val: { displayName: 'person@example.test', api_key: 'DO-NOT-RETURN' } } }] }) } } })
    const account = await f.service.account('user-a', 'account', 'auth')
    expect(account.identity).toBe('person@example.test')
    expect(JSON.stringify(account)).not.toContain('DO-NOT-RETURN')
  })
  test('profile keeps workspace identity and stable provider ID; sync failures redact SDK payloads', async () => {
    const f = fixture()
    Object.assign(f.service, { instance: {
      toolkits: { get: async () => ({ getCurrentUserEndpoint: '/me', getCurrentUserEndpointMethod: 'GET' }) },
      tools: { proxyExecute: async () => ({ status: 200, data: { id: 'bot-id', workspace_name: 'My workspace', bot: { owner: { user: {} } }, access_token: 'DO-NOT-RETURN' } }) },
      connectedAccounts: { list: async () => { throw new Error('DO-NOT-RETURN') } },
    } })
    expect(await f.service.profile('account', 'notion')).toEqual({ identity: 'My workspace', identityId: 'bot-id' })
    await expect(f.service.account('user-a', 'account', 'auth')).rejects.toThrow('Could not refresh this account')
  })
})
