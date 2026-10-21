import { z } from 'zod'

export const ToolkitSlug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/)
export const ConnectAccount = z.object({
  toolkit: ToolkitSlug,
  authScheme: z.enum(['OAUTH2', 'OAUTH1', 'API_KEY']).optional(),
  label: z.string().trim().max(100).default(''),
  fields: z.record(z.string().max(100), z.string().max(16000)).default({}),
  projectId: z.string().min(1).optional(),
  returnPath: z.string().max(2048).regex(/^\/(?!\/)[^\\#]*$/)
    .refine(path => [...path].every(char => char.charCodeAt(0) >= 32)).optional(),
  reconnectId: z.string().min(1).optional(),
})
export type ConnectAccount = z.infer<typeof ConnectAccount>
export type AuthField = {
  name: string; label: string; description: string; required: boolean; secret: boolean; type: string; defaultValue?: string
}
export type AuthMethod = { scheme: 'OAUTH2' | 'OAUTH1' | 'API_KEY'; fields: AuthField[]; hintUrl?: string }
export type ConnectionApp = { slug: string; name: string; logo: string | null; authSchemes: string[]; available: boolean }
export type AccountView = {
  id: string; toolkit: string; appName: string; logo: string | null; authScheme: string
  label: string; identity: string | null; state: string; createdAt: string; syncedAt: string | null
  projects: { id: string; name: string }[]
}
export type ConnectionsView = { enabled: boolean; connections: AccountView[]; syncFailed: boolean }
export type ProjectConnectionsView = ConnectionsView & { enabledIds: string[]; defaults: Record<string, string>; selectedId: string | null }
