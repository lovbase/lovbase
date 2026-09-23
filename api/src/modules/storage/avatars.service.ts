import { Injectable, Logger } from '@nestjs/common'
import type pg from 'pg'
import { InjectPool } from '../../database/pool.provider'
import { StorageService } from './storage.service'
import { FILES_PREFIX } from './attachments.service'
import { avatarKey, avatarPrefix } from './keys'

/** Small on purpose: an avatar renders at 36px, and anything larger is someone's camera roll. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

/** Raster formats only. SVG is an executable document and this one is served from our own origin. */
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

const EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
}

/**
 * A person's own picture, replacing the drawn identicon.
 *
 * Kept under `public/avatar/<userId>/`, which is served without an access check — an avatar shows
 * up beside a shared project, to viewers who are not the owner. The previous one is swept on every
 * change: the URL is stored on the user row, so an orphan would be unreachable and still billed.
 */
@Injectable()
export class AvatarsService {
  private readonly log = new Logger('avatars')

  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly storage: StorageService) {}

  get enabled() { return this.storage.enabled }

  /** The stored URL for the new picture. Throws with a readable message on anything unacceptable. */
  async set(userId: string, bytes: Uint8Array, contentType: string): Promise<string> {
    if (!this.storage.enabled) throw new Error('Object storage is not configured, so avatars cannot be uploaded')
    const type = contentType.split(';')[0].trim().toLowerCase()
    if (!(AVATAR_TYPES as readonly string[]).includes(type)) throw new Error('Only PNG, JPEG, WebP or GIF are supported')
    if (bytes.byteLength > MAX_AVATAR_BYTES) throw new Error('Avatars must be 2MB or smaller')
    if (bytes.byteLength === 0) throw new Error('The file is empty')

    const key = avatarKey(userId, crypto.randomUUID(), EXT[type])
    await this.storage.put(key, bytes, type)
    const url = FILES_PREFIX + key
    // Sweep first, then point at the new one: the reverse order would leave the row naming an
    // object that is already gone if the delete succeeded and the update did not.
    await this.sweepExcept(userId, key)
    await this.pool.query(`UPDATE public."user" SET image = $2, "updatedAt" = now() WHERE id = $1`, [userId, url])
    return url
  }

  /** Back to the drawn identicon. */
  async clear(userId: string) {
    await this.pool.query(`UPDATE public."user" SET image = NULL, "updatedAt" = now() WHERE id = $1`, [userId])
    if (this.storage.enabled) await this.storage.deletePrefix(avatarPrefix(userId)).catch(() => 0)
  }

  private async sweepExcept(userId: string, keep: string) {
    try {
      for (const k of await this.storage.list(avatarPrefix(userId))) if (k !== keep) await this.storage.delete(k)
    } catch (e) {
      // An orphaned object costs a fraction of a cent; failing the upload over it would be worse.
      this.log.warn(`could not sweep old avatars for ${userId}: ${e instanceof Error ? e.message : e}`)
    }
  }
}
