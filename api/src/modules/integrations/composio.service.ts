import { Injectable, Logger, Optional } from '@nestjs/common'
import { AuthScheme, Composio, SessionPreset } from '@composio/core'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { ConfigService } from '../../config/config.service'
import { DomainError } from '../../common/errors'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { CreditsService } from '../credits/credits.service'
import type { SheetInfo, SheetSource } from '@lovbase/core/sheets'
import { SHEETS_MAX_BYTES } from '@lovbase/core/sheets'
import type { AuthMethod, ConnectionApp } from '@lovbase/core/connections'
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
  constructor(
    private readonly cfg: ConfigService,
    @Optional() @InjectPool() private readonly pool?: pg.Pool,
    @Optional() private readonly schema?: SchemaService,
    @Optional() private readonly credits?: CreditsService,
  ) {}
  get enabled() { return !!this.cfg.env.COMPOSIO_API_KEY }
  private get meteringEnabled() { return !!this.pool && !!this.schema && !!this.credits }
  private get client() {
    if (!this.enabled) throw new DomainError('Google Sheets integration is not configured.')
    return this.instance ??= new Composio({ apiKey: this.cfg.env.COMPOSIO_API_KEY, allowTracking: false })
  }

  private periodStart(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  }

  /** Hobby is hard-capped by Composio. Check before making a request so we fail locally first. */
  private async assertHobbyLimit(userId: string, kind: 'tool_call' | 'trigger') {
    if (!this.meteringEnabled || this.cfg.env.COMPOSIO_PLAN !== 'hobby') return
    await this.schema!.ready()
    const limit = kind === 'tool_call' ? this.cfg.env.COMPOSIO_HOBBY_TOOL_CALL_LIMIT : this.cfg.env.COMPOSIO_HOBBY_TRIGGER_LIMIT
    const r = await this.pool!.query(
      'SELECT count(*)::int AS used FROM public.lb_composio_usage_events WHERE kind=$1 AND occurred_at >= $2',
      [kind, this.periodStart().toISOString()],
    )
    if (Number(r.rows[0]?.used ?? 0) >= limit)
      throw new DomainError(`Composio Hobby ${kind === 'tool_call' ? 'tool-call' : 'trigger'} quota is exhausted for this month.`)
  }

  private async recordEvent(input: {
    userId: string; kind: 'tool_call' | 'trigger' | 'connection'; toolkit?: string; toolSlug?: string;
    operation?: string; externalId?: string; idempotencyKey?: string; projectId?: string;
  }) {
    if (!this.meteringEnabled) return
    await this.schema!.ready()
    await this.pool!.query(
      `INSERT INTO public.lb_composio_usage_events
        (user_id,project_id,kind,toolkit,tool_slug,operation,external_id,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (idempotency_key) DO NOTHING`,
      [input.userId, input.projectId ?? null, input.kind, input.toolkit ?? null, input.toolSlug ?? null,
        input.operation ?? null, input.externalId ?? null, input.idempotencyKey ?? randomUUID()],
    )
  }

  /** Called by the trigger webhook boundary after a provider event has been verified. */
  async recordTriggerEvent(userId: string, eventId: string, toolkit: string, trigger: string) {
    if (this.meteringEnabled) {
      await this.schema!.ready()
      const existing = await this.pool!.query('SELECT 1 FROM public.lb_composio_usage_events WHERE idempotency_key=$1', [`trigger:${eventId}`])
      if (existing.rowCount) return
    }
    await this.assertHobbyLimit(userId, 'trigger')
    await this.recordEvent({ userId, kind: 'trigger', toolkit, operation: trigger, externalId: eventId, idempotencyKey: `trigger:${eventId}` })
  }

  /** Connection management is tracked now, but Hobby has no connection charge. */
  async recordConnectionOperation(userId: string, accountId: string, operation: string, toolkit?: string) {
    await this.recordEvent({ userId, kind: 'connection', toolkit, operation, externalId: accountId, idempotencyKey: `connection:${operation}:${accountId}:${randomUUID()}` })
  }

  /**
   * Reconcile paid Composio usage. The SDK exposes exact project dollars and user-scoped quantities;
   * the latter are used to allocate the former without retaining provider payloads.
   */
  async reconcileUsage() {
    if (!this.meteringEnabled || !this.enabled || this.cfg.env.COMPOSIO_PLAN !== 'pro') return
    await this.schema!.ready()
    const from = this.periodStart(), to = new Date(), fromMs = from.getTime(), toMs = to.getTime()
    const usage = (this.client as any).experimental?.usage
    if (!usage) return
    try {
      const [summary, breakdown, local] = await Promise.all([
        usage.summary({ from: fromMs, to: toMs, entityTypes: ['tool_calls', 'triggers'] }),
        usage.breakdown('tool_calls', { from: fromMs, to: toMs, groupBy: 'user_id', limit: 1000 }),
        this.pool!.query(`SELECT user_id,
          count(*) FILTER (WHERE kind IN ('tool_call','trigger'))::int AS events,
          count(*) FILTER (WHERE kind='connection')::int AS connections
          FROM public.lb_composio_usage_events WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY user_id`, [from.toISOString(), to.toISOString()]),
      ])
      const groups = new Map<string, number>((breakdown.groups ?? []).map((g: any) => [String(g.key), Number(g.totalQuantity) || 0]))
      const localRows = local.rows as Array<{ user_id: string; events: number; connections: number }>
      const totalEvents = localRows.reduce((n, r) => n + Number(r.events), 0)
      const totalConnections = localRows.reduce((n, r) => n + Number(r.connections), 0)
      if (!localRows.length) return
      const providerCharge = Math.max(0, Number(summary.instantCharge) - this.cfg.env.COMPOSIO_PRO_USAGE_CREDIT_USD)
      const connectionCharge = Math.max(0, totalConnections - this.cfg.env.COMPOSIO_CONNECTION_FREE_LIMIT) * this.cfg.env.COMPOSIO_CONNECTION_COST_USD
      for (const row of localRows) {
        const toolWeight = groups.get(row.user_id) ?? Number(row.events)
        const eventUsd = totalEvents ? providerCharge * (toolWeight / Math.max(1, totalEvents)) : 0
        const connectionUsd = totalConnections ? connectionCharge * (Number(row.connections) / totalConnections) : 0
        const allocatedUsd = eventUsd + connectionUsd
        const targetCredits = Math.ceil(allocatedUsd / 0.01)
        const previous = await this.pool!.query('SELECT charged_credits,allocated_usd FROM public.lb_composio_reconciliations WHERE period_start=$1 AND user_id=$2', [from.toISOString(), row.user_id])
        const already = Number(previous.rows[0]?.charged_credits ?? 0)
        const previousUsd = Number(previous.rows[0]?.allocated_usd ?? 0)
        const delta = Math.max(0, targetCredits - already)
        if (delta && await this.credits!.charge(row.user_id, {
          kind: 'composio', idempotencyKey: `composio:${from.toISOString()}:${row.user_id}:${targetCredits}`,
          credits: delta, costUsd: Math.max(0, allocatedUsd - previousUsd), note: 'Composio usage reconciliation',
        })) {
          await this.pool!.query(`INSERT INTO public.lb_composio_reconciliations
            (period_start,user_id,allocated_usd,charged_credits,provider_charge_usd)
            VALUES($1,$2,$3,$4,$5)
            ON CONFLICT (period_start,user_id) DO UPDATE SET allocated_usd=$3,charged_credits=$4,provider_charge_usd=$5,updated_at=now()`,
            [from.toISOString(), row.user_id, allocatedUsd, Math.max(already, targetCredits), Number(summary.instantCharge) || 0])
        } else {
          await this.pool!.query(`INSERT INTO public.lb_composio_reconciliations
            (period_start,user_id,allocated_usd,charged_credits,provider_charge_usd)
            VALUES($1,$2,$3,$4,$5)
            ON CONFLICT (period_start,user_id) DO UPDATE SET allocated_usd=$3,provider_charge_usd=$5,updated_at=now()`,
            [from.toISOString(), row.user_id, allocatedUsd, already, Number(summary.instantCharge) || 0])
        }
      }
    } catch (error) {
      this.logger.warn(`Composio usage reconciliation deferred: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  async catalog(query = '', cursor?: string): Promise<{ items: ConnectionApp[]; cursor: string | null }> {
    try {
      // The core SDK's list drops pagination metadata; its public API client retains it.
      const page = await this.client.getClient().toolkits.list({ search: query || undefined, cursor, limit: 30, sort_by: 'usage' })
      return { items: page.items.map(t => ({ slug: t.slug, name: t.name, logo: t.meta.logo ?? null,
        authSchemes: t.auth_schemes ?? [],
        available: !!t.composio_managed_auth_schemes?.some(s => s === 'OAUTH2' || s === 'OAUTH1') || !!t.auth_schemes?.includes('API_KEY'),
      })), cursor: page.next_cursor ?? null }
    } catch { throw new DomainError('Could not load applications. Please retry.') }
  }
  async authentication(toolkit: string): Promise<{ app: ConnectionApp; methods: AuthMethod[] }> {
    try {
      const t = await this.client.toolkits.get(toolkit)
      const methods: AuthMethod[] = []
      for (const auth of t.authConfigDetails ?? []) {
        const scheme = auth.mode
        if (scheme !== 'API_KEY' && scheme !== 'OAUTH2' && scheme !== 'OAUTH1') continue
        if (scheme !== 'API_KEY' && !t.composioManagedAuthSchemes?.includes(scheme)) continue
        const fields = [...auth.fields.connectedAccountInitiation.required.map(f => Object.assign({}, f, { required: true })),
          ...auth.fields.connectedAccountInitiation.optional.map(f => Object.assign({}, f, { required: false }))]
          .filter(f => f.userVisible !== false)
          .map(f => ({ name: f.name, label: f.displayName, description: f.description, required: f.required,
            secret: f.isSecret ?? (scheme === 'API_KEY'), type: f.type,
            // Never send a secret default back to the browser.
            ...(!f.isSecret && scheme !== 'API_KEY' && f.default ? { defaultValue: f.default } : {}),
          }))
        methods.push({ scheme, fields: scheme === 'API_KEY' ? fields : [], ...(auth.authHintUrl?.startsWith('https://') ? { hintUrl: auth.authHintUrl } : {}) })
      }
      methods.sort((a, b) => Number(a.scheme === 'API_KEY') - Number(b.scheme === 'API_KEY'))
      return { app: { slug: t.slug, name: t.name, logo: t.meta.logo ?? null, authSchemes: methods.map(m => m.scheme), available: methods.length > 0 }, methods }
    } catch { throw new DomainError('Could not load authentication settings. Please retry.') }
  }
  async createAuthConfig(toolkit = 'googlesheets', scheme: 'OAUTH2' | 'OAUTH1' | 'API_KEY' = 'OAUTH2') {
    try {
      const result = await this.client.authConfigs.create(toolkit, scheme === 'API_KEY' ? {
        type: 'use_custom_auth', authScheme: 'API_KEY', name: `Lovbase ${toolkit}`, credentials: {},
      } : {
        type: 'use_composio_managed_auth', name: toolkit === 'googlesheets' ? 'Lovbase Sheets read only' : `Lovbase ${toolkit}`,
        ...(toolkit === 'googlesheets' ? { credentials: { scopes: 'https://www.googleapis.com/auth/spreadsheets.readonly' } } : {}),
      })
      return result.id
    } catch { throw new DomainError('Could not configure this application. Administrator setup may be required.') }
  }
  async authorize(userId: string, authConfigId: string, callbackUrl: string, toolkit = 'googlesheets') {
    const session = await this.client.create(userId, {
      toolkits: [toolkit], authConfigs: { [toolkit]: authConfigId }, sandbox: { enable: false },
      multiAccount: { enable: true },
      ...(toolkit === 'googlesheets' ? { tools: { googlesheets: READ_TOOLS } } : {}),
    })
    try {
      const request = await session.authorize(toolkit, { callbackUrl })
      if (!request.redirectUrl) throw new DomainError('Could not start authorization. Try again.')
      return { accountId: request.id, url: request.redirectUrl }
    } catch { throw new DomainError('Could not start authorization. Try again.') }
    finally { await session.delete().catch(() => {}) }
  }
  async connectKey(userId: string, authConfigId: string, fields: Record<string, string>) {
    try {
      const request = await this.client.connectedAccounts.initiate(userId, authConfigId, {
        allowMultiple: true, config: AuthScheme.APIKey(fields),
      })
      await this.recordConnectionOperation(userId, request.id, 'connect', undefined)
      return request.id
    } catch { throw new DomainError('Could not connect with these credentials. Check the fields and retry.') }
  }
  async account(userId: string, accountId: string, authConfigId: string, toolkit = 'googlesheets') {
    if (!this.enabled) throw new DomainError('Connections are not configured.')
    try { return await this.accountForUser(userId, accountId, authConfigId, toolkit) }
    catch { throw new DomainError('Could not refresh this account. Please retry.') }
  }
  private async accountForUser(userId: string, accountId: string, authConfigId: string, toolkit: string) {
    // User-filtered listing proves remote ownership; never return authentication state.
    let cursor: string | undefined
    do {
      const page = await this.client.connectedAccounts.list({ userIds: [userId], authConfigIds: [authConfigId], toolkitSlugs: [toolkit], limit: 100, cursor })
      const account = page.items.find(a => a.id === accountId)
      if (account) {
        const identity = z.object({ displayName: z.string().min(1).max(500).optional() }).safeParse(account.state?.val ?? {})
        return { active: account.status === 'ACTIVE' && !account.isDisabled && !account.authConfig.isDisabled,
          label: account.alias || toolkit, status: account.status, identity: identity.success ? identity.data.displayName ?? null : null }
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return { active: false, label: toolkit, status: 'NOT_FOUND', identity: null }
  }
  async profile(accountId: string, toolkit: string): Promise<{ identity: string | null; identityId: string | null }> {
    try {
      const t = await this.client.toolkits.get(toolkit)
      // Profile discovery is read-only, even when toolkit metadata advertises another method.
      if (!t.getCurrentUserEndpoint || t.getCurrentUserEndpointMethod !== 'GET') return { identity: null, identityId: null }
      const r = await this.client.tools.proxyExecute({ endpoint: t.getCurrentUserEndpoint, method: 'GET', connectedAccountId: accountId })
      if (r.status !== 200) return { identity: null, identityId: null }
      const p = z.record(z.string(), z.unknown()).parse(r.data)
      const objects = [p, p.user, p.owner, p.data, p.bot].filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
      const keys = ['email', 'emailAddress', 'login', 'username', 'workspace_name', 'name', 'display_name', 'displayName']
      const identity = objects.flatMap(v => keys.map(k => v[k])).find(v => typeof v === 'string' && v.length > 0 && v.length <= 500) as string | undefined
      const rawId = p.id ?? p.sub ?? p.user_id
      const identityId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).slice(0, 500) : null
      return { identity: identity ?? null, identityId }
    } catch { return { identity: null, identityId: null } }
  }
  async disconnect(accountId: string, userId?: string, toolkit?: string) {
    try {
      await this.client.connectedAccounts.delete(accountId)
      if (userId) await this.recordConnectionOperation(userId, accountId, 'disconnect', toolkit)
    }
    catch (error) { if ((error as { status?: number }).status !== 404) throw new DomainError('Access is disabled locally. Remote disconnection failed; retry disconnecting.') }
  }

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
        await this.assertHobbyLimit(userId, 'tool_call')
        // Only idempotent reads retry; credentials and provider response bodies never enter logs.
        for (let attempt = 0; ; attempt++) {
          try {
            // The session already pins this user's connection. The per-call `account` option
            // is rejected by projects where Composio multi-account selection is not enabled.
            const result = await session.execute(slug, args)
            if (result.resultType !== 'completed') throw new DomainError('Google Sheets could not be read. Check access to this file, then retry.')
            await this.recordEvent({ userId, kind: 'tool_call', toolkit: 'googlesheets', toolSlug: slug, idempotencyKey: `tool:${userId}:${randomUUID()}` })
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
