/**
 * A project's files as one piece of text, so moving a whole tree is one round trip.
 *
 * Export and import used to be a request per file — thirty-five sequential trips into the container
 * each way, and from the other side of the world that was most of a restore. The tree now crosses
 * as a single stream in a shape a POSIX shell can produce and consume with `find`, `base64` and
 * `read`, and this module is the other half of that contract.
 *
 * The format is line pairs: a relative path, then the file's bytes as unwrapped base64. Base64 so
 * that any content survives — a shell cannot pass arbitrary bytes on a line, and a generated app
 * can contain a font. A sentinel closes the stream, and reading without it is an error rather than
 * a shorter file list: this feeds the snapshot that a fresh container is rebuilt from, and a
 * truncated export written over it would be source silently lost.
 */

export type AppFile = { path: string; content: string }

export const END = '<<lovbase:end>>'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Base64 without a stack-sized spread: `String.fromCharCode(...bytes)` dies past ~100KB. */
function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Relative, inside the tree, no traversal — the same rule the file endpoints apply. */
export function safeRel(p: string): string | null {
  const rel = p.replace(/^\/+/, '')
  if (!rel || rel.includes('..') || rel.includes('\0') || rel.includes('\n')) return null
  return rel
}

/** The shell reads this back with `read -r` twice per file; see the import route. */
export function pack(files: AppFile[]): string {
  const lines: string[] = []
  for (const f of files) {
    const rel = safeRel(f.path)
    if (!rel) continue
    lines.push(rel, toBase64(enc.encode(f.content)))
  }
  lines.push(END)
  return lines.join('\n') + '\n'
}

/**
 * The inverse, for what the shell wrote. Throws on a stream with no sentinel: a container's exec
 * output can be cut short, and the caller must not mistake a shorter list for a smaller project.
 */
export function unpack(text: string): AppFile[] {
  const lines = text.split('\n')
  const end = lines.lastIndexOf(END)
  if (end < 0) throw new Error('export was cut short: no end marker')
  const out: AppFile[] = []
  for (let i = 0; i + 1 < end; i += 2) {
    const path = lines[i]
    if (!path) continue
    out.push({ path, content: dec.decode(fromBase64(lines[i + 1])) })
  }
  return out.toSorted((a, b) => a.path.localeCompare(b.path))
}
