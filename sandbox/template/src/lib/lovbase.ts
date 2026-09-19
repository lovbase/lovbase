// The ONLY way this app touches data. Do not add another backend.
const base = import.meta.env.VITE_LOVBASE_URL as string
const ws = import.meta.env.VITE_LOVBASE_WORKSPACE as string
const token = import.meta.env.VITE_LOVBASE_TOKEN as string

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base}/api/data/${ws}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await r.json()
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
  return body as T
}

export type Field = { id: string; name: string; dbName: string; type: 'text' | 'number' | 'boolean' | 'date' | 'select' | 'link'; required: boolean; options?: string[]; linkTo?: string }
export type Entity = { id: string; name: string; dbName: string; fields: Field[] }
export type IR = { appName: string; entities: Entity[]; readOnly?: boolean }

/** One SQL statement (SELECT/INSERT/UPDATE/DELETE) with $1.. params, run as the workspace role. Reads are capped at 1000 rows. */
export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await call<{ rows: T[] }>('/sql', { method: 'POST', body: JSON.stringify({ sql: text, params }) })
  return r.rows
}

export const schema = () => call<{ ir: IR; readOnly?: boolean }>('/schema').then((r) => ({ ...r.ir, readOnly: !!r.readOnly }))
