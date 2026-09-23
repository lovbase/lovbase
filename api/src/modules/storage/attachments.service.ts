import { Injectable, Logger } from '@nestjs/common'
import type { UIMessage } from 'ai'
import { StorageService } from './storage.service'
import { chatAttachmentKey, chatPrefixes, parseKey } from './keys'

// ── Getting uploads out of the transcript ──
//
// A file part arrives from the browser as a `data:` URL, and the transcript is stored as one JSON
// column. Left alone, a 2 MB screenshot becomes ~2.7 MB of base64 inside `lb_chat.messages`, is
// read back in full every time the project page loads, and rides along to the model on every
// later turn of that conversation. `slice(-200)` bounds the number of messages, not their size.
//
// So: on the way in, the bytes go to object storage and the part keeps a URL. On the way to the
// model they are read back. Both directions live here so the rule is in one place — the chat
// controller should not know what a data URL is.

/** Public path for a stored attachment. Also the shape `keyFor` expects back. */
export const FILES_PREFIX = '/api/files/'

const urlFor = (key: string) => FILES_PREFIX + key

/** The storage key behind a served URL, or null when the URL is not one of ours. */
export const keyFor = (url: string): string | null => {
  if (!url?.startsWith(FILES_PREFIX)) return null
  const key = url.slice(FILES_PREFIX.length)
  // parseKey is the single answer to "is this one of ours", `..` and legacy shapes included.
  return parseKey(key) ? key : null
}

/** Ceiling per file, matched to the composer's own limit. The client cap is a courtesy; this one counts. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

type FilePart = { type: 'file'; url: string; mediaType: string; filename?: string }
const isFile = (p: unknown): p is FilePart =>
  !!p && typeof p === 'object' && (p as { type?: string }).type === 'file' && typeof (p as FilePart).url === 'string'

/** `data:<mediaType>;base64,<payload>` → bytes, or null if it is not a data URL we can read. */
function decodeDataUrl(url: string): { bytes: Uint8Array; mediaType: string } | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url)
  if (!m) return null
  const [, mediaType, isBase64, payload] = m
  try {
    const bytes = isBase64
      ? Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(payload))
    return { bytes, mediaType: mediaType || 'application/octet-stream' }
  } catch { return null }
}

const toDataUrl = (bytes: Uint8Array, mediaType: string) => {
  let bin = ''
  // In chunks: `String.fromCharCode(...bytes)` blows the argument limit on anything megabyte-sized.
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${mediaType};base64,${btoa(bin)}`
}

@Injectable()
export class AttachmentsService {
  private readonly log = new Logger('attachments')

  constructor(private readonly storage: StorageService) {}

  /**
   * Replace inline bytes with stored ones, so what gets persisted is a URL.
   *
   * Returns the messages unchanged when storage is not configured — self-hosters without a bucket
   * keep the old behaviour rather than losing the ability to attach anything at all.
   */
  async offload(projectId: string, messages: UIMessage[]): Promise<UIMessage[]> {
    if (!this.storage.enabled) return messages
    const out = await Promise.all(messages.map(async (m) => ({
      ...m,
      parts: await Promise.all((m.parts ?? []).map(async (part) => {
        if (!isFile(part)) return part
        const decoded = decodeDataUrl(part.url)
        if (!decoded) return part // already a stored URL, or something we did not write
        if (decoded.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          return { type: 'text' as const, text: `[Attachment ${part.filename ?? ''} is over 8MB and was skipped]` }
        }
        const key = chatAttachmentKey(projectId, crypto.randomUUID(), part.filename)
        try {
          await this.storage.put(key, decoded.bytes, part.mediaType || decoded.mediaType)
          return { ...part, url: urlFor(key) }
        } catch (e) {
          // Never lose the turn over storage: keep it inline this once and say so in the log.
          this.log.warn(`offload failed for ${key}, keeping inline: ${e instanceof Error ? e.message : e}`)
          return part
        }
      })),
    })))
    return out as UIMessage[]
  }

  /**
   * Read stored attachments back into the messages, for the model call.
   *
   * The model gets bytes either way; this is what lets the stored form be a URL. One read per
   * attachment per turn is a Class B operation — cheap enough that uniformity beats an
   * optimisation that would make the current turn behave differently from the history.
   */
  async rehydrate(messages: UIMessage[]): Promise<UIMessage[]> {
    if (!this.storage.enabled) return messages
    const out = await Promise.all(messages.map(async (m) => ({
      ...m,
      parts: await Promise.all((m.parts ?? []).map(async (part) => {
        if (!isFile(part)) return part
        const key = keyFor(part.url)
        if (!key) return part
        try {
          const got = await this.storage.get(key)
          if (!got) return { type: 'text' as const, text: `[Attachment ${part.filename ?? ''} no longer exists]` }
          return { ...part, url: toDataUrl(got.bytes, part.mediaType || got.contentType) }
        } catch (e) {
          this.log.warn(`rehydrate failed for ${key}: ${e instanceof Error ? e.message : e}`)
          return { type: 'text' as const, text: `[Attachment ${part.filename ?? ''} could not be read]` }
        }
      })),
    })))
    return out as UIMessage[]
  }

  /** Everything a project ever uploaded, for when the project goes. */
  async deleteProject(projectId: string): Promise<number> {
    if (!this.storage.enabled) return 0
    // Both shapes: a project older than the key change has files under the legacy prefix, and
    // deleting the project has to leave nothing behind either way.
    let n = 0
    for (const prefix of chatPrefixes(projectId)) n += await this.storage.deletePrefix(prefix)
    return n
  }
}
