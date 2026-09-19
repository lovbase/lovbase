import type { IR } from '../shared/ir'
import type { Change } from '../shared/diff'

export type LogRow = { id: number; role: string; content: any; created_at: string }
export type State = { ir: IR; ddl: string; log: LogRow[]; hasKey: boolean; model: string }
export type GenerateResult = {
  applied: boolean
  needsConfirmation?: boolean
  pendingId?: string
  changes: Change[]
  error?: string
}

const j = async (r: Response) => {
  const body = await r.json()
  if (!r.ok) throw new Error(body.error ?? r.statusText)
  return body
}

export const fetchState = (): Promise<State> => fetch('/api/state').then(j)
export const generate = (message: string): Promise<GenerateResult> =>
  fetch('/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }).then(j)
export const confirm = (pendingId: string): Promise<GenerateResult> =>
  fetch('/api/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingId }),
  }).then(j)
export const listRows = (entityId: string): Promise<any[]> =>
  fetch(`/api/data/${entityId}`).then(j)
export const insertRow = (entityId: string, values: Record<string, unknown>) =>
  fetch(`/api/data/${entityId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  }).then(j)
export const deleteRow = (entityId: string, rowId: string) =>
  fetch(`/api/data/${entityId}/${rowId}`, { method: 'DELETE' }).then(j)
