import { Injectable, Logger } from '@nestjs/common'
import { AwsClient } from 'aws4fetch'
import { ConfigService } from '../../config/config.service'

// Object storage for anything a user uploads. Speaks plain S3, so the same code runs against R2 in
// the hosted product and MinIO in the self-hosted compose file — the only difference is the
// endpoint. Both address a bucket as a path (`<endpoint>/<bucket>/<key>`), so there is no
// addressing style to configure.
//
// Deliberately small: whole objects in, whole objects out. Attachments are screenshots and CSVs,
// not video, so there is no multipart upload here and no reason to add one.


@Injectable()
export class StorageService {
  private readonly log = new Logger('storage')
  private client: AwsClient | null = null

  constructor(private readonly cfg: ConfigService) {}

  /** False when no bucket is configured; callers fall back to keeping bytes inline. */
  get enabled() { return this.cfg.storageConfigured }

  private get aws(): AwsClient {
    const { S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION } = this.cfg.env
    this.client ??= new AwsClient({
      accessKeyId: S3_ACCESS_KEY_ID!,
      secretAccessKey: S3_SECRET_ACCESS_KEY!,
      service: 's3',
      region: S3_REGION,
    })
    return this.client
  }

  private url(key: string, at?: { bucket: string; endpoint: string }) {
    const base = (at?.endpoint ?? this.cfg.env.S3_ENDPOINT!).replace(/\/+$/, '')
    // Encode each segment but keep the separators: a key is a path, not one opaque string.
    const path = key.split('/').map(encodeURIComponent).join('/')
    return `${base}/${at?.bucket ?? this.cfg.env.S3_BUCKET}/${path}`
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const type = contentType || 'application/octet-stream'
    const res = await this.aws.fetch(this.url(key), {
      method: 'PUT',
      body: new Blob([body], { type }),
      headers: { 'content-type': type },
    })
    if (!res.ok) throw new Error(`storage put ${key} failed: ${res.status} ${await res.text().catch(() => '')}`)
  }

  /**
   * Null for a missing object rather than a throw: a deleted attachment must not break a transcript.
   *
   * `at` reads a different bucket in the same account — the sandbox's, which holds published apps
   * and build snapshots. The credentials are one account's, so this needs no second client, but the
   * endpoint travels with the bucket: R2 hides a bucket from every jurisdiction endpoint but its
   * own, and answers `NoSuchBucket` when you ask the wrong one.
   */
  async get(key: string, at?: { bucket: string; endpoint: string }): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const res = await this.aws.fetch(this.url(key, at))
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`storage get ${key} failed: ${res.status}`)
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    }
  }

  async delete(key: string): Promise<void> {
    const res = await this.aws.fetch(this.url(key), { method: 'DELETE' })
    // S3 returns 204 for a delete of something that was never there; treat 404 the same way.
    if (!res.ok && res.status !== 404) this.log.warn(`storage delete ${key}: ${res.status}`)
  }

  /** Every object under a prefix. Paged, because one list response caps at 1000 keys. */
  async list(prefix: string): Promise<string[]> {
    const out: string[] = []
    let token: string | undefined
    do {
      const base = this.cfg.env.S3_ENDPOINT!.replace(/\/+$/, '')
      const q = new URLSearchParams({ 'list-type': '2', prefix })
      if (token) q.set('continuation-token', token)
      const res = await this.aws.fetch(`${base}/${this.cfg.env.S3_BUCKET}?${q}`)
      if (!res.ok) { this.log.warn(`storage list ${prefix}: ${res.status}`); return out }
      const xml = await res.text()
      out.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => decodeXml(m[1])))
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]
        : undefined
    } while (token)
    return out
  }

  /** Every object under a prefix, gone — for tearing down a project. */
  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.list(prefix)
    for (const k of keys) await this.delete(k)
    return keys.length
  }
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
