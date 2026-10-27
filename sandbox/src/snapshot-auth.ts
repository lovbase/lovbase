/** Per-app, short-lived snapshot capability signed by the API and verified by the sandbox. */
export async function snapshotSignature(appId: string, expires: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`snapshot:${appId}:${expires}`)))
  return [...signature.subarray(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function snapshotHost(appId: string, secret: string, now = Date.now()) {
  if (!/^[a-z0-9]{1,16}$/.test(appId) || !secret) throw new Error('Snapshot signing unavailable')
  const expires = (Math.floor(now / 1000) + 3600).toString(36)
  return `snap-${appId}-${expires}-${await snapshotSignature(appId, expires, secret)}`
}

export async function verifySnapshotHost(host: string, secret: string, now = Date.now()): Promise<string | null> {
  const match = /^snap-([a-z0-9]{1,16})-([a-z0-9]{1,7})-([a-f0-9]{32})$/.exec(host)
  if (!match || !secret) return null
  const [, appId, expires, signature] = match
  const timestamp = parseInt(expires, 36)
  if (timestamp <= Math.floor(now / 1000) || timestamp > Math.floor(now / 1000) + 3600) return null
  const expected = await snapshotSignature(appId, expires, secret)
  let difference = 0
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return difference === 0 ? appId : null
}
