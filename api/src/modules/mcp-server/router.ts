import express from 'express'
import type { INestApplication } from '@nestjs/common'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ConfigService } from '../../config/config.service'
import { McpOAuthService, MCP_SCOPE } from './oauth.service'
import { McpToolsService } from './tools.service'

/** Mount before Nest registers its catch-all handlers. Parsing stays local to these routes. */
export function mountMcp(app: INestApplication) {
  const cfg = app.get(ConfigService)
  if (!cfg.mcpServerEnabled) return
  const oauth = app.get(McpOAuthService), tools = app.get(McpToolsService)
  const http = app.getHttpAdapter().getInstance() as express.Express
  // Rate-limit by the actual peer, never the globally permissive Express trust-proxy value.
  // Behind a gateway this is a shared cap; authenticated tools also have per-account limits.
  const rateLimit = { windowMs: 60_000, limit: 300, keyGenerator: (req: express.Request) => req.socket.remoteAddress || 'unknown' }
  http.use(mcpAuthRouter({ provider: oauth, issuerUrl: new URL('/',cfg.env.BETTER_AUTH_URL), resourceServerUrl: new URL(oauth.url),
    scopesSupported: [MCP_SCOPE], resourceName: 'Lovbase', authorizationOptions: { rateLimit }, tokenOptions: { rateLimit },
    revocationOptions: { rateLimit }, clientRegistrationOptions: { rateLimit: { ...rateLimit, limit: 30 } } }))
  const router = express.Router()
  router.use((req,res,next) => {
    res.set('Cache-Control','no-store')
    const origin = req.get('origin')
    if (origin && !cfg.trustedOrigins.includes(origin) && origin !== new URL(cfg.env.BETTER_AUTH_URL).origin) {
      res.status(403).json({ error: 'Untrusted Origin' }); return
    }
    if (origin) res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
      'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'WWW-Authenticate' })
    if (req.method === 'OPTIONS') { res.status(204).end(); return }
    next()
  })
  router.use(requireBearerAuth({ verifier: oauth, requiredScopes: [MCP_SCOPE], resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource/mcp',cfg.env.BETTER_AUTH_URL).href }))
  // eslint-disable-next-line oxc/no-async-endpoint-handlers -- Express 5 handles rejected promises; cleanup is also explicit below.
  router.post('/',express.json({ limit: '1mb' }),async (req,res,next) => {
    let server: Awaited<ReturnType<McpToolsService['server']>> | undefined
    let transport: StreamableHTTPServerTransport | undefined
    try {
      server = await tools.server(String(req.auth!.extra!.userId),req.auth!.clientId)
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.once('close',() => { void transport?.close(); void server?.close() })
      await server.connect(transport)
      await transport.handleRequest(req,res,req.body)
    } catch (error) { await transport?.close(); await server?.close(); next(error) }
  })
  router.all('/',(_req,res) => { res.status(405).set('Allow','POST, OPTIONS').json({ error: 'Use stateless Streamable HTTP POST requests' }) })
  // Exact path: /mcp/authorize belongs to the consent UI, not this router.
  http.use('/mcp',(req,res,next) => {
    if (req.path !== '/') { next(); return }
    router(req,res,next)
  })
}
