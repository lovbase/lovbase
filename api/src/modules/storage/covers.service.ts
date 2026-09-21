import { Injectable, Logger } from '@nestjs/common'
import { SandboxService } from '../sandbox/sandbox.service'
import { StorageService } from './storage.service'
import { FILES_PREFIX } from './attachments.service'
import { thumbKey, thumbPrefix } from './keys'

/**
 * The cover on a project card.
 *
 * Drawn wireframes say a project exists; they do not say which one it is. A screenshot of the
 * published app does, and a published app is exactly the thing that can be photographed without
 * waking anything — it is sitting in object storage answering requests.
 *
 * Never on the critical path. A publish that worked must not report failure because a screenshot
 * did not, and a missing cover costs nothing: the card falls back to the wireframe it drew before.
 */
@Injectable()
export class CoversService {
  private readonly log = new Logger('covers')

  constructor(
    private readonly storage: StorageService,
    private readonly sandbox: SandboxService,
  ) {}

  /** The URL a cover would live at, whether or not one has been taken. */
  urlFor(projectId: string, appId: string) { return FILES_PREFIX + thumbKey(projectId, appId) }

  /** Photograph a published app. Resolves either way; the caller is not meant to wait on it. */
  async capture(projectId: string, appId: string, publishedUrl: string): Promise<void> {
    if (!this.storage.enabled) return
    try {
      const png = await this.sandbox.thumb(publishedUrl)
      if (!png) return // no browser on this backend
      await this.storage.put(thumbKey(projectId, appId), png, 'image/png')
    } catch (e) {
      this.log.warn(`cover for ${appId} failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  /** Everything a project's covers occupy, for when the project goes. */
  async deleteProject(projectId: string): Promise<number> {
    if (!this.storage.enabled) return 0
    return this.storage.deletePrefix(thumbPrefix(projectId)).catch(() => 0)
  }
}
