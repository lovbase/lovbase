import { Injectable } from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import type pg from 'pg'
import type { Response } from 'express'
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js'
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { ConfigService } from '../../config/config.service'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { NotFound } from '../../common/errors'
import type { UserCtx } from '../auth/access.service'

export const MCP_SCOPE = 'lovbase:manage'
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const secret = () => randomBytes(32).toString('base64url')
type Params = Omit<AuthorizationParams, 'resource'> & { resource: string }

@Injectable()
export class McpOAuthService implements OAuthServerProvider {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService, private readonly cfg: ConfigService) {}
  get url() { return new URL('/mcp', this.cfg.env.BETTER_AUTH_URL).href }
  get enabled() { return this.cfg.mcpServerEnabled }
  private assertEnabled() { if (!this.enabled) throw new NotFound('MCP server is disabled') }
  private resource(resource?: URL) {
    if (resource && resource.href !== this.url) throw new InvalidTargetError('Unknown MCP resource')
  }
  private scopes(scopes?: string[]) {
    if (scopes?.some(s => s !== MCP_SCOPE)) throw new InvalidScopeError('Unsupported scope')
  }
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async id => {
        this.assertEnabled(); await this.schema.ready()
        return (await this.pool.query('SELECT metadata FROM public.lb_mcp_clients WHERE id=$1', [id])).rows[0]?.metadata
      },
      registerClient: async input => {
        this.assertEnabled(); await this.schema.ready()
        // Native MCP clients are public clients. Never persist a client secret in metadata.
        if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none')
          throw new InvalidClientMetadataError('Use token_endpoint_auth_method=none with PKCE')
        if (!input.redirect_uris.length || input.redirect_uris.length > 10) throw new InvalidClientMetadataError('Invalid redirect URIs')
        for (const raw of input.redirect_uris) {
          const u = new URL(raw)
          if (u.hash || u.username || u.password || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname))))
            throw new InvalidClientMetadataError('Redirects must use HTTPS or HTTP loopback')
        }
        const client: OAuthClientInformationFull = {
          client_id: secret(), client_id_issued_at: Math.floor(Date.now()/1000),
          client_name: (input.client_name || 'MCP client').slice(0,120), redirect_uris: input.redirect_uris,
          token_endpoint_auth_method: 'none', grant_types: ['authorization_code','refresh_token'], response_types: ['code'], scope: MCP_SCOPE,
        }
        await this.pool.query('INSERT INTO public.lb_mcp_clients(id,metadata) VALUES($1,$2)', [client.client_id, JSON.stringify(client)])
        return client
      },
    }
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.assertEnabled(); this.resource(params.resource); this.scopes(params.scopes)
    const id = secret()
    await this.pool.query(`INSERT INTO public.lb_mcp_authorizations(id,client_id,params,expires_at)
      VALUES($1,$2,$3,now()+interval '10 minutes')`, [id, client.client_id, JSON.stringify({ ...params, resource: this.url })])
    res.redirect(new URL(`/mcp/authorize?request=${id}`, this.cfg.env.BETTER_AUTH_URL).href)
  }
  async consentRequest(ctx: UserCtx, id: string) {
    this.assertEnabled(); await this.schema.ready()
    const r = await this.pool.query(`UPDATE public.lb_mcp_authorizations SET user_id=$2
      WHERE id=$1 AND (user_id IS NULL OR user_id=$2) AND consumed_at IS NULL AND expires_at>now()
      RETURNING client_id`, [id,ctx.user.id])
    if (!r.rowCount) throw new NotFound('Authorization expired. Connect again from your client.')
    const client = await this.clientsStore.getClient(r.rows[0].client_id)
    return { clientName: client?.client_name || 'MCP client', email: ctx.user.email }
  }
  async decide(ctx: UserCtx, id: string, allow: boolean) {
    this.assertEnabled()
    return this.transaction(async db => {
      const r = await db.query(`UPDATE public.lb_mcp_authorizations SET consumed_at=now()
        WHERE id=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING *`, [id, ctx.user.id])
      if (!r.rowCount) throw new NotFound('Authorization expired. Connect again from your client.')
      const row = r.rows[0], params = row.params as Params, redirect = new URL(params.redirectUri)
      if (params.state !== undefined) redirect.searchParams.set('state', params.state)
      if (!allow) { redirect.searchParams.set('error','access_denied'); return { redirect: redirect.href } }
      const grant = secret(), code = secret()
      await db.query('INSERT INTO public.lb_mcp_grants(id,user_id,client_id) VALUES($1,$2,$3)', [grant,ctx.user.id,row.client_id])
      await db.query(`UPDATE public.lb_mcp_authorizations SET code_hash=$2,code_expires_at=now()+interval '5 minutes',grant_id=$3 WHERE id=$1`, [id,digest(code),grant])
      redirect.searchParams.set('code',code)
      return { redirect: redirect.href }
    })
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const r = await this.pool.query(`SELECT params FROM public.lb_mcp_authorizations WHERE code_hash=$1 AND client_id=$2 AND code_expires_at>now()`, [digest(code),client.client_id])
    if (!r.rowCount) throw new InvalidGrantError('Invalid authorization code')
    return (r.rows[0].params as Params).codeChallenge
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, verifier?: string, redirectUri?: string, resource?: URL) {
    this.assertEnabled(); this.resource(resource)
    return this.transaction(async db => {
      const r = await db.query(`SELECT * FROM public.lb_mcp_authorizations WHERE code_hash=$1 AND client_id=$2 AND code_expires_at>now() FOR UPDATE`, [digest(code),client.client_id])
      if (!r.rowCount) throw new InvalidGrantError('Invalid authorization code')
      const row = r.rows[0], p = row.params as Params
      // The SDK verifies PKCE before invoking this method (and omits verifier afterwards).
      if ((verifier && createHash('sha256').update(verifier).digest('base64url') !== p.codeChallenge) || redirectUri !== p.redirectUri)
        throw new InvalidGrantError('Invalid verifier or redirect URI')
      await db.query('UPDATE public.lb_mcp_authorizations SET code_hash=NULL WHERE id=$1', [row.id])
      return this.issue(db,row.grant_id)
    })
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL) {
    this.assertEnabled(); this.resource(resource); this.scopes(scopes)
    // Lock the grant first: refresh, revocation and token issuance use the same lock order.
    const result = await this.transaction(async db => {
      const r = await db.query(`SELECT g.id FROM public.lb_mcp_grants g JOIN public.lb_mcp_tokens t ON t.grant_id=g.id
        WHERE t.hash=$1 AND t.kind='refresh' AND g.client_id=$2 AND g.revoked_at IS NULL FOR UPDATE OF g`, [digest(token),client.client_id])
      if (!r.rowCount) throw new InvalidGrantError('Invalid refresh token')
      const grant = r.rows[0].id
      const t = (await db.query('SELECT * FROM public.lb_mcp_tokens WHERE hash=$1', [digest(token)])).rows[0]
      if (t.consumed_at) {
        await db.query('UPDATE public.lb_mcp_grants SET revoked_at=now() WHERE id=$1', [grant])
        return null
      }
      if (new Date(t.expires_at).getTime() <= Date.now()) throw new InvalidGrantError('Refresh token expired')
      await db.query('UPDATE public.lb_mcp_tokens SET consumed_at=now() WHERE hash=$1', [digest(token)])
      return this.issue(db,grant)
    })
    if (!result) throw new InvalidGrantError('Refresh token already used; reconnect')
    return result
  }
  private async issue(db: pg.PoolClient, grant: string) {
    const r = await db.query('SELECT id FROM public.lb_mcp_grants WHERE id=$1 AND revoked_at IS NULL FOR UPDATE', [grant])
    if (!r.rowCount) throw new InvalidGrantError('Authorization revoked')
    const access = secret(), refresh = secret()
    await db.query(`INSERT INTO public.lb_mcp_tokens(hash,grant_id,kind,expires_at) VALUES
      ($1,$3,'access',now()+interval '1 hour'),($2,$3,'refresh',now()+interval '30 days')`, [digest(access),digest(refresh),grant])
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: MCP_SCOPE }
  }
  async verifyAccessToken(token: string) {
    this.assertEnabled(); await this.schema.ready()
    const r = await this.pool.query(`SELECT g.id,g.user_id,g.client_id,t.expires_at FROM public.lb_mcp_tokens t
      JOIN public.lb_mcp_grants g ON g.id=t.grant_id JOIN public."user" u ON u.id=g.user_id
      WHERE t.hash=$1 AND t.kind='access' AND t.expires_at>now() AND g.revoked_at IS NULL`, [digest(token)])
    if (!r.rowCount) throw new InvalidTokenError('Invalid or expired token')
    const g = r.rows[0]
    await this.pool.query('UPDATE public.lb_mcp_grants SET last_used_at=now() WHERE id=$1', [g.id])
    return { token, clientId: g.client_id as string, scopes: [MCP_SCOPE], resource: new URL(this.url),
      expiresAt: Math.floor(new Date(g.expires_at).getTime()/1000), extra: { userId: g.user_id as string, grantId: g.id as string } }
  }
  async revokeToken(client: OAuthClientInformationFull, req: OAuthTokenRevocationRequest) {
    await this.pool.query(`UPDATE public.lb_mcp_grants SET revoked_at=now() WHERE client_id=$1
      AND id IN (SELECT grant_id FROM public.lb_mcp_tokens WHERE hash=$2)`, [client.client_id,digest(req.token)])
  }
  async grants(ctx: UserCtx) {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT g.id,c.metadata->>'client_name' AS name,g.created_at,g.last_used_at
      FROM public.lb_mcp_grants g JOIN public.lb_mcp_clients c ON c.id=g.client_id
      WHERE g.user_id=$1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC`, [ctx.user.id])
    return r.rows.map(row => ({ id: String(row.id), name: String(row.name), createdAt: new Date(row.created_at).toISOString(), lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null }))
  }
  async revoke(ctx: UserCtx, id: string) {
    await this.pool.query('UPDATE public.lb_mcp_grants SET revoked_at=now() WHERE id=$1 AND user_id=$2', [id,ctx.user.id])
    return { ok: true }
  }
  private async transaction<T>(fn: (db: pg.PoolClient) => Promise<T>) {
    await this.schema.ready()
    const db = await this.pool.connect()
    try { await db.query('BEGIN'); const out = await fn(db); await db.query('COMMIT'); return out }
    catch (e) { await db.query('ROLLBACK'); throw e } finally { db.release() }
  }
}
