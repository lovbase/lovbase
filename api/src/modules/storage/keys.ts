/**
 * Object keys, laid out so the first segment says who may read it and the second says what it is:
 *
 *   private/chat/<projectId>/<id><ext>    a chat attachment — served behind the project check
 *   public/avatar/<userId>/<id><ext>      an avatar — served to anyone holding the URL
 *
 * The bucket is private in both cases. `public` describes the serving rule, not the bucket: it
 * means the route does not apply an access check, because an avatar is shown to people who are not
 * the owner and often are not signed in at all. Keeping that word first means "who may read this"
 * is answerable from a prefix, without knowing anything about the business object underneath — and
 * that a whole class can be listed or swept in one call.
 *
 * Attachments used to live under `projects/<projectId>/`. Those keys are inside transcripts that
 * are already saved, so reads still accept them; only writes use the new shape.
 */

export type Scope = 'private' | 'public'
export type Kind = 'chat' | 'avatar'

/** Lowercased extension, or nothing. A name that is mostly dots must not become the extension. */
export const extOf = (filename?: string) => filename?.match(/\.[a-z0-9]{1,8}$/i)?.[0]?.toLowerCase() ?? ''

export const chatAttachmentKey = (projectId: string, id: string, filename?: string) =>
  `private/chat/${projectId}/${id}${extOf(filename)}`

export const avatarKey = (userId: string, id: string, filename?: string) =>
  `public/avatar/${userId}/${id}${extOf(filename)}`

/** Everything belonging to one project, both shapes, so deleting it leaves nothing behind. */
export const chatPrefixes = (projectId: string) => [`private/chat/${projectId}/`, `projects/${projectId}/`]

export const avatarPrefix = (userId: string) => `public/avatar/${userId}/`

export type ParsedKey = { scope: Scope; kind: Kind; owner: string }

/**
 * What a key is and whose it is, or null when it is not a key this application writes. A `..`
 * anywhere makes it null rather than something to be cleaned up: a key that needs normalising is
 * not one of ours.
 */
export function parseKey(key: string): ParsedKey | null {
  if (!key || key.includes('//') || key.split('/').includes('..')) return null
  const seg = key.split('/')
  // Legacy: projects/<projectId>/<file>
  if (seg[0] === 'projects' && seg.length >= 3 && seg[1])
    return { scope: 'private', kind: 'chat', owner: seg[1] }
  if (seg.length < 4) return null
  const [scope, kind, owner] = seg
  if (scope === 'private' && kind === 'chat' && owner) return { scope, kind, owner }
  if (scope === 'public' && kind === 'avatar' && owner) return { scope, kind, owner }
  return null
}
