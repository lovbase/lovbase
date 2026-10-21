import { createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { redirect } from '@tanstack/react-router'
import { ConfigService, McpOAuthService, svc } from '@lovbase/api'
import { z } from 'zod'
import { currentUser, requireUser } from './_ctx'

const requestInput = z.object({ request: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
export const getMcpServerInfo = createServerFn().handler(async () => {
  await requireUser()
  const oauth = await svc(McpOAuthService)
  return { enabled: oauth.enabled, url: oauth.url }
})
export const getMcpGrants = createServerFn().handler(async () => {
  setResponseHeader('Cache-Control','no-store')
  return (await svc(McpOAuthService)).grants(await requireUser())
})
function checkOrigin(cfg: ConfigService) {
  const origin = getRequest().headers.get('origin')
  if (!origin || (origin !== new URL(cfg.env.BETTER_AUTH_URL).origin && !cfg.trustedOrigins.includes(origin))) throw new Error('Invalid request origin')
}
export const revokeMcpGrant = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().min(1).max(128) }))
  .handler(async ({ data }) => {
    const ctx = await requireUser()
    checkOrigin(await svc(ConfigService))
    return (await svc(McpOAuthService)).revoke(ctx,data.id)
  })
export const getMcpConsent = createServerFn({ method: 'POST' }).validator(requestInput).handler(async ({ data }) => {
  setResponseHeader('Cache-Control','no-store')
  const user = await currentUser()
  if (!user) throw redirect({ to: '/login', search: { returnTo: `/mcp/authorize?request=${data.request}` } })
  return (await svc(McpOAuthService)).consentRequest({ user },data.request)
})
export const decideMcpConsent = createServerFn({ method: 'POST' })
  .validator(requestInput.extend({ allow: z.boolean() }))
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control','no-store')
    const ctx = await requireUser()
    checkOrigin(await svc(ConfigService))
    return (await svc(McpOAuthService)).decide(ctx,data.request,data.allow)
  })
