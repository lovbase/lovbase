import type { Product3dClient, Product3dData, Product3dResult } from '@lovbase/core/product-3d'
const base = import.meta.env.VITE_LOVBASE_URL as string
const workspace = import.meta.env.VITE_LOVBASE_WORKSPACE as string
const token = import.meta.env.VITE_LOVBASE_TOKEN as string
async function call<T>(body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api/data/${workspace}/product-3d`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || result.message || 'request_failed')
  return result as T
}
export const product3dClient: Product3dClient = {
  read: () => call<Product3dData>(),
  command: (command) => call<Product3dResult>(command),
}
