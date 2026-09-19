const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Lowercase alphanumeric id. Callers prefix it with a letter so `p_<id>` stays a legal identifier. */
export function randomId(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  let s = ''
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length]
  return s
}
