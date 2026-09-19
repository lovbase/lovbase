const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Share tokens are generated here because they only ever exist for a UI toggle. */
export function randomShareToken(len = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let s = ''
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length]
  return s
}
