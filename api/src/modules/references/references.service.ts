import { Injectable, Logger } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { DomainError, NotFound } from '../../common/errors'
import { StorageService } from '../storage/storage.service'
import { SandboxService } from '../sandbox/sandbox.service'
import { AppsService } from '../apps/apps.service'
import { referenceDestination, referencePath, type ReferenceCopyFile } from '@lovbase/sandbox/reference-policy'
import { ReferenceFetcher, REFERENCE_LIMITS, type ReferenceManifest } from './reference-fetch'

const prefix = (projectId: string, id: string) => {
  if (!/^[a-z0-9]+$/.test(projectId) || !/^[a-f0-9-]{36}$/.test(id)) throw new NotFound('Reference not found')
  return `private/reference/${projectId}/${id}/`
}

@Injectable()
export class ReferencesService {
  private readonly log = new Logger('references')
  constructor(private readonly storage: StorageService, private readonly sandbox: SandboxService, private readonly apps: AppsService) {}

  private configured() {
    if (!this.storage.enabled) throw new DomainError('External references require private object storage to be configured')
  }

  protected fetcher() { return new ReferenceFetcher() }

  async fetch(projectId: string, url: string) {
    this.configured()
    const id = randomUUID()
    const root = prefix(projectId, id)
    const signal = AbortSignal.timeout(REFERENCE_LIMITS.timeoutMs)
    const started = performance.now()
    let phase = 'source download'
    let uploading = false
    let completed = 0
    let total = 0
    const elapsedMs = () => Math.round(performance.now() - started)
    this.log.log(JSON.stringify({ event: 'reference_started', projectId, id }))
    try {
      const { manifest, contents } = await this.fetcher().fetch(url, id, signal)
      this.log.log(JSON.stringify({ event: 'reference_downloaded', projectId, id, files: manifest.files.length, elapsedMs: elapsedMs() }))
      phase = 'private storage upload'
      // Each put still reserves/settles quota through StorageService. Bound concurrency rather
      // than paying two remote storage round trips serially for every repository file.
      const files = [...new Map(manifest.files.map(file => [file.sha256, file])).values()]
      total = files.length
      let cursor = 0
      const failures: unknown[] = []
      uploading = true
      await Promise.all(Array.from({ length: Math.min(6, files.length) }, async () => {
        while (!failures.length && cursor < files.length) {
          const file = files[cursor++]
          try {
            signal.throwIfAborted()
            await this.storage.put(root + file.sha256, contents.get(file.path)!, 'application/octet-stream')
            completed++
            if (completed % 25 === 0 || completed === total) {
              this.log.log(JSON.stringify({ event: 'reference_upload_progress', projectId, id, completed, total, elapsedMs: elapsedMs() }))
            }
          } catch (error) { failures.push(error) }
        }
      }))
      // All in-flight puts must settle before rollback, or a late writer can recreate deleted
      // objects and quota entries. A failed batch never writes its manifest commit marker.
      if (failures.length) throw failures[0]
      phase = 'manifest commit'
      // The manifest is the commit marker. Failed fetches/uploads are never returned as complete references.
      signal.throwIfAborted()
      await this.storage.put(root + 'manifest.json', Buffer.from(JSON.stringify(manifest)), 'application/json')
      signal.throwIfAborted()
      this.log.log(JSON.stringify({ event: 'reference_completed', projectId, id, completed, total, elapsedMs: elapsedMs() }))
      return manifest
    } catch (error) {
      this.log.warn(JSON.stringify({ event: 'reference_failed', projectId, id, phase, completed, total,
        elapsedMs: elapsedMs(), error: error instanceof Error ? error.message : 'Unknown reference failure' }))
      if (uploading) {
        try { await this.storage.deletePrefix(root) }
        catch { this.log.error(JSON.stringify({ event: 'reference_cleanup_failed', projectId, id })) }
      }
      if (signal.reason?.name === 'TimeoutError' && (error === signal.reason
        || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) {
        throw new DomainError(`External reference exceeded the ${REFERENCE_LIMITS.timeoutMs / 1000}s deadline during ${phase} (${completed}/${total} objects uploaded before rollback). Reference acquisition did not complete.`)
      }
      throw error
    }
  }

  async manifest(projectId: string, id: string): Promise<ReferenceManifest> {
    this.configured()
    const got = await this.storage.get(prefix(projectId, id) + 'manifest.json')
    if (!got) throw new NotFound('Reference not found in this project')
    return JSON.parse(Buffer.from(got.bytes).toString('utf8'))
  }

  private async bytes(projectId: string, id: string, file: ReferenceManifest['files'][number]) {
    const got = await this.storage.get(prefix(projectId, id) + file.sha256)
    if (!got || got.bytes.byteLength !== file.size || createHash('sha256').update(got.bytes).digest('hex') !== file.sha256) {
      throw new DomainError('Reference file is missing or failed integrity verification; fetch again')
    }
    return got.bytes
  }

  async read(projectId: string, id: string, path: string, offset = 0, limit = 16000) {
    if (path !== ':index') referencePath(path)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 40000) {
      throw new DomainError('Invalid read range; limit must be 1–40000 characters')
    }
    const manifest = await this.manifest(projectId, id)
    if (path === ':index') {
      const content = JSON.stringify(manifest, null, 2)
      return { id, path, content: content.slice(offset, offset + limit), offset,
        nextOffset: Math.min(content.length, offset + limit), totalCharacters: content.length,
        truncated: offset + limit < content.length, untrusted: true }
    }
    const file = manifest.files.find(entry => entry.path === path)
    if (!file) throw new NotFound('Reference file not found')
    const bytes = await this.bytes(projectId, id, file)
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (content.includes('\0')) throw new Error('Binary content')
    } catch { return { id, ...file, binary: true, untrusted: true } }
    return { id, ...file, content: content.slice(offset, offset + limit), offset,
      nextOffset: Math.min(content.length, offset + limit), totalCharacters: content.length,
      truncated: offset + limit < content.length, untrusted: true }
  }

  /** Returns verified bytes only; the trusted sandbox copier applies the exact same policy again. */
  async prepareCopy(projectId: string, id: string, paths: string[], destination = '.') {
    if (!paths.length || paths.length > REFERENCE_LIMITS.files) throw new DomainError('Select 1–2000 files or directories')
    if (destination !== '.') referencePath(destination)
    const manifest = await this.manifest(projectId, id)
    const selected = new Set<ReferenceManifest['files'][number]>()
    for (const input of paths) {
      const path = referencePath(input.endsWith('/') ? input.slice(0, -1) : input)
      const matches = manifest.files.filter(file => file.path === path || file.path.startsWith(path + '/'))
      if (!matches.length) throw new NotFound(`Reference path not found: ${path}`)
      for (const file of matches) selected.add(file)
    }
    const files = [...selected].map(file => ({ file,
      target: referenceDestination(destination === '.' ? file.path : `${destination}/${file.path}`) }))
    const result: ReferenceCopyFile[] = []
    for (const { file, target } of files) {
      result.push({ path: target, content: Buffer.from(await this.bytes(projectId, id, file)).toString('base64'), encoding: 'base64', sha256: file.sha256 })
    }
    return result
  }

  /** Caller already holds the app's sandbox lease, as for every other Agent file tool. */
  async copy(projectId: string, appId: string, id: string, paths: string[], destination = '.') {
    await this.apps.get(projectId, appId)
    const files = await this.prepareCopy(projectId, id, paths, destination)
    const result = await this.sandbox.copyReferenceFiles(appId, files)
    try {
      const exported = await this.sandbox.exportFiles(appId)
      if (!exported.files.length) throw new DomainError('Cannot save an empty application snapshot')
      await this.apps.saveSnapshot(appId, exported.files)
    } catch (error) {
      await this.sandbox.resetSource(appId)
      throw error
    }
    return result
  }
}
