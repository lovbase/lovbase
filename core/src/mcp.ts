import { z } from 'zod'

export const McpAuth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('oauth'), clientId: z.string().trim().max(512).optional(), clientSecret: z.string().max(4096).optional() })
    .refine(v => !v.clientSecret || !!v.clientId, 'Client ID is required when a client secret is supplied.'),
  z.object({ type: z.literal('token'), token: z.string().min(1).max(4096).regex(/^[\x20-\x7e]+$/, 'Invalid token.'),
    headerName: z.string().trim().max(128).regex(/^[a-zA-Z][a-zA-Z0-9-]*$/).refine(value => {
      const name = value.toLowerCase()
      return !['host', 'cookie', 'set-cookie', 'connection', 'content-length', 'content-type', 'accept', 'transfer-encoding', 'proxy-authorization', 'origin', 'referer', 'upgrade', 'te', 'trailer'].includes(name)
        && !name.startsWith('sec-') && !name.startsWith('proxy-') && !name.startsWith('mcp-')
    }, 'This header is reserved.').optional(),
  }),
  z.object({ type: z.literal('none') }),
])
export const McpServerInput = z.object({
  name: z.string().trim().min(1).max(100), url: z.string().trim().url().max(2048), auth: McpAuth,
  projectId: z.string().min(1).max(200).optional(), returnTo: z.enum(['dialog', 'settings']).default('dialog'),
})
export const McpReconnectInput = z.object({
  serverId: z.string().min(1), name: z.string().trim().min(1).max(100).optional(), url: z.string().trim().url().max(2048).optional(), auth: McpAuth.optional(), projectId: z.string().min(1).optional(),
  returnTo: z.enum(['dialog', 'settings']).default('dialog'),
})
export const McpRegistryInput = z.object({ url: z.string().trim().url().max(2048), displayName: z.string().trim().max(100).optional(), bearerToken: z.string().max(4096).optional() })
export type McpAuthInput = z.infer<typeof McpAuth>
