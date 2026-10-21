import type { InventoryClient, InventoryData } from '@lovbase/core/inventory'
const base = import.meta.env.VITE_LOVBASE_URL as string
const workspace = import.meta.env.VITE_LOVBASE_WORKSPACE as string
const token = import.meta.env.VITE_LOVBASE_TOKEN as string
async function call<T>(body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api/data/${workspace}/inventory`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || result.message || 'generic_error')
  return result as T
}
export const inventoryClient: InventoryClient = {
  read: () => call<InventoryData>(),
  command: (command) => call(command),
}
