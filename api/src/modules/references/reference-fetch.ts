import { createHash } from 'node:crypto'
import { parse } from 'parse5'
import { DomainError } from '../../common/errors'
import { mcpFetch, safeMcpUrl } from '../integrations/mcp-network'
import { referencePath } from '@lovbase/sandbox/reference-policy'

export const REFERENCE_LIMITS = { fileBytes: 10 * 1024 * 1024, totalBytes: 50 * 1024 * 1024, files: 2000, timeoutMs: 120_000 }
export type ReferenceFile = { path: string; size: number; sha256: string; contentType: string; sourceUrl: string }
export type ReferenceManifest = {
  id: string; sourceUrl: string; resolvedUrl: string; kind: 'github' | 'web'; fetchedAt: string
  commit?: string; license?: string; files: ReferenceFile[]; excluded: { path: string; reason: string }[]
  warnings: string[]; limits: typeof REFERENCE_LIMITS
}
export type FetchedReference = { manifest: ReferenceManifest; contents: Map<string, Uint8Array> }
type Transport = (url: string, init: RequestInit) => Promise<Response>
type HtmlNode = { nodeName: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[] }

const filePriority = (path: string) => !path.includes('/') ? 0
  : /(^|\/)(index|page|layout|App|main)\.[^/]+$/.test(path) ? 1 : 2

/** Compact handoff; directory selectors avoid enumerating assets in both agents' context. */
export function referenceSummary(manifest: ReferenceManifest) {
  const directories = new Map<string, { path: string; fileCount: number; bytes: number }>()
  for (const file of manifest.files) {
    const parts = file.path.split('/')
    if (parts.length < 2) continue
    const path = parts.slice(0, Math.min(2, parts.length - 1)).join('/') + '/'
    const entry = directories.get(path) ?? { path, fileCount: 0, bytes: 0 }
    entry.fileCount++
    entry.bytes += file.size
    directories.set(path, entry)
  }
  let directorySize = 0
  const groups = [...directories.values()]
  const visibleGroups = groups.filter(group => {
    directorySize += group.path.length + 70
    return directorySize <= 4000
  }).slice(0, 40)
  const candidates = manifest.files.toSorted((a, b) => filePriority(a.path) - filePriority(b.path) || a.path.localeCompare(b.path))
  let indexSize = 0
  const files: { path: string; size: number }[] = []
  for (const { path, size } of candidates) {
    indexSize += path.length + 40
    if (indexSize > 4000 || files.length >= 40) break
    files.push({ path, size })
  }
  return { id: manifest.id, sourceUrl: manifest.sourceUrl, resolvedUrl: manifest.resolvedUrl, kind: manifest.kind,
    fetchedAt: manifest.fetchedAt, commit: manifest.commit, license: manifest.license, files,
    directories: visibleGroups, directoriesTruncated: visibleGroups.length < groups.length,
    fileCount: manifest.files.length, indexTruncated: files.length < manifest.files.length, indexPath: ':index',
    fileListPath: ':files',
    excluded: manifest.excluded.slice(0, 20).map(item => ({ path: item.path.slice(0, 500), reason: item.reason.slice(0, 500) })),
    excludedCount: manifest.excluded.length, warnings: [...new Set(manifest.warnings)].slice(0, 20), limits: manifest.limits, untrusted: true }
}

export function referenceUrl(raw: string) {
  if (raw.length > 4096) throw new DomainError('Reference URL is too long')
  const url = new URL(raw)
  url.hash = ''
  safeMcpUrl(url.href)
  if (url.port && url.port !== '443') throw new DomainError('References require HTTPS on port 443')
  return url
}

/** Network access is fixed to GET, anonymous, DNS-pinned, and manually validated at every hop. */
export class ReferenceFetcher {
  constructor(private readonly transport: Transport = mcpFetch(120_000, 15 * 1024 * 1024, undefined, 'manual') as Transport) {}

  async fetch(raw: string, id: string, signal = AbortSignal.timeout(REFERENCE_LIMITS.timeoutMs)): Promise<FetchedReference> {
    const source = referenceUrl(raw)
    const manifest: ReferenceManifest = {
      id, sourceUrl: source.href, resolvedUrl: source.href, kind: source.hostname === 'github.com' ? 'github' : 'web',
      fetchedAt: new Date().toISOString(), files: [], excluded: [], warnings: [], limits: { ...REFERENCE_LIMITS },
    }
    const contents = new Map<string, Uint8Array>()
    let total = 0
    const add = (path: string, bytes: Uint8Array, type: string, url: string) => {
      signal.throwIfAborted()
      referencePath(path)
      if (contents.has(path)) throw new DomainError('Duplicate reference path')
      total += bytes.byteLength
      if (bytes.byteLength > REFERENCE_LIMITS.fileBytes || total > REFERENCE_LIMITS.totalBytes
        || contents.size >= REFERENCE_LIMITS.files) throw new DomainError('Reference exceeds file, count or total size limit')
      contents.set(path, bytes)
      manifest.files.push({ path, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), contentType: type, sourceUrl: url })
    }
    const get = async (rawUrl: string, maxBytes = REFERENCE_LIMITS.fileBytes) => {
      let url = referenceUrl(rawUrl)
      for (let hop = 0; ; hop++) {
        signal.throwIfAborted()
        const response = await this.transport(url.href, {
          method: 'GET', redirect: 'manual', credentials: 'omit', signal,
          headers: { 'user-agent': 'Lovbase-Reference/1.0', accept: '*/*', 'accept-encoding': 'identity' },
        })
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel()
          if (hop >= 3 || !response.headers.get('location')) throw new DomainError('Reference redirect limit exceeded')
          url = referenceUrl(new URL(response.headers.get('location')!, url).href)
          continue
        }
        if (!response.ok) {
          await response.body?.cancel()
          throw new DomainError(`Reference HTTP ${response.status} at ${url.origin}${url.pathname} (login, rate limit or unavailable resource)`)
        }
        if (Number(response.headers.get('content-length')) > maxBytes) {
          await response.body?.cancel()
          throw new DomainError('Reference file exceeds size limit')
        }
        const reader = response.body?.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            if (!reader) break
            signal.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > maxBytes) throw new DomainError('Reference file exceeds size limit')
            chunks.push(value)
          }
        } finally { await reader?.cancel().catch(() => {}) }
        return { bytes: Buffer.concat(chunks), url: url.href, type: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' }
      }
    }
    if (manifest.kind === 'github') {
      const segments = source.pathname.split('/').filter(Boolean)
      if (segments.length !== 2) throw new DomainError('Use a GitHub repository root URL; branches are resolved to a fixed commit')
      const [owner, repo] = segments.map(value => value.replace(/\.git$/, ''))
      if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new DomainError('Invalid GitHub repository')
      const api = `https://api.github.com/repos/${owner}/${repo}`
      const json = async (url: string) => JSON.parse((await get(url)).bytes.toString('utf8'))
      const metadata = await json(api)
      if (metadata.private || typeof metadata.default_branch !== 'string') throw new DomainError('Only public GitHub repositories are supported')
      const commit = await json(`${api}/commits/${encodeURIComponent(metadata.default_branch)}`)
      if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new DomainError('Invalid GitHub commit')
      manifest.commit = commit.sha
      manifest.license = metadata.license?.spdx_id ?? 'Not specified; inspect repository notices before reuse'
      manifest.resolvedUrl = `https://github.com/${owner}/${repo}/tree/${commit.sha}`
      const tree = await json(`${api}/git/trees/${commit.sha}?recursive=1`)
      if (tree.truncated || !Array.isArray(tree.tree)) throw new DomainError('GitHub tree is truncated; refusing an incomplete reference')
      const files: { path: string; size: number; sha: string }[] = []
      let declaredBytes = 0
      for (const entry of tree.tree) {
        referencePath(entry.path)
        if (entry.type === 'tree' && entry.mode === '040000') continue
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
          manifest.excluded.push({ path: entry.path, reason: 'Symlink, submodule or special file is not fetched' })
          continue
        }
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > REFERENCE_LIMITS.fileBytes
          || !/^[a-f0-9]{40}$/.test(entry.sha)) throw new DomainError('Invalid or oversized GitHub file')
        declaredBytes += entry.size
        files.push(entry)
      }
      if (files.length > REFERENCE_LIMITS.files || declaredBytes > REFERENCE_LIMITS.totalBytes) throw new DomainError('Repository exceeds reference limits')
      // Official immutable raw-content endpoint avoids the anonymous REST API's 60 requests/hour cap.
      // Every response is verified against the blob object ID from GitHub's pinned tree.
      let cursor = 0
      let failure: unknown
      await Promise.all(Array.from({ length: Math.min(6, files.length) }, async () => {
        while (!failure && cursor < files.length) {
          const entry = files[cursor++]
          const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commit.sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}`
          try {
            const file = await get(url)
            const blob = createHash('sha1').update(`blob ${file.bytes.length}\0`).update(file.bytes).digest('hex')
            if (blob !== entry.sha || file.bytes.length !== entry.size) throw new DomainError('GitHub blob integrity check failed')
            if (file.bytes.subarray(0, 150).toString().startsWith('version https://git-lfs.github.com/spec/v1')) {
              manifest.excluded.push({ path: entry.path, reason: 'Git LFS pointer; actual asset was not downloaded' })
            } else add(entry.path, file.bytes, file.type, url)
          } catch (error) { failure = error }
        }
      }))
      if (failure) throw failure
    } else {
      const page = await get(source.href)
      manifest.resolvedUrl = page.url
      if (!['text/html', 'application/xhtml+xml', 'text/plain', 'text/css'].includes(page.type)) {
        throw new DomainError('Web references require HTML, plain text or CSS')
      }
      add(page.type === 'text/css' ? 'page.css' : page.type === 'text/plain' ? 'page.txt' : 'page.html', page.bytes, page.type, page.url)
      if (page.type.includes('html')) {
        const document = parse(page.bytes.toString('utf8')) as HtmlNode
        const text: string[] = []
        const assets = new Map<string, 'image' | 'css'>()
        let inline = 0
        const walk = (node: HtmlNode, hidden = false) => {
          const attrs = Object.fromEntries((node.attrs ?? []).map(a => [a.name, a.value]))
          if (node.nodeName === 'base') manifest.warnings.push('HTML base URL ignored; linked resources resolve against the fetched document')
          if (node.nodeName === 'script') {
            manifest.excluded.push({ path: attrs.src ?? '(inline script)', reason: 'Web scripts are not fetched or executed' })
            return
          }
          if (node.nodeName === 'input' && attrs.type === 'password') manifest.warnings.push('Page contains a login form; authenticated content was not fetched')
          const link = node.nodeName === 'img' ? attrs.src
            : node.nodeName === 'link' && attrs.rel?.toLowerCase().split(/\s+/).includes('stylesheet') ? attrs.href : undefined
          if (link) {
            try { assets.set(referenceUrl(new URL(link, page.url).href).href, node.nodeName === 'img' ? 'image' : 'css') }
            catch { manifest.excluded.push({ path: link, reason: 'Unsupported or unsafe asset URL' }) }
          }
          if (['img', 'source'].includes(node.nodeName) && attrs.srcset) {
            for (const candidate of attrs.srcset.split(',')) {
              const imageUrl = candidate.trim().split(/\s+/)[0]
              if (!imageUrl) continue
              try { assets.set(referenceUrl(new URL(imageUrl, page.url).href).href, 'image') }
              catch { manifest.excluded.push({ path: imageUrl, reason: 'Unsupported or unsafe image URL' }) }
            }
          }
          if (node.nodeName === 'style') {
            add(`styles/inline-${++inline}.css`, Buffer.from((node.childNodes ?? []).map(n => n.value ?? '').join('')), 'text/css', page.url)
            return
          }
          const skip = hidden || ['head', 'noscript', 'template'].includes(node.nodeName)
          if (node.nodeName === '#text' && !skip && node.value?.trim()) text.push(node.value.trim())
          for (const child of node.childNodes ?? []) walk(child, skip)
        }
        walk(document)
        add('page.txt', Buffer.from(text.join('\n')), 'text/plain', page.url)
        if (assets.size + contents.size > REFERENCE_LIMITS.files) throw new DomainError('Page exceeds reference file count limit')
        let index = 0
        for (const [url, kind] of assets) {
          let file: Awaited<ReturnType<typeof get>>
          try { file = await get(url) }
          catch (error) {
            signal.throwIfAborted()
            if (error instanceof Error && /size limit|redirect limit/.test(error.message)) throw error
            manifest.excluded.push({ path: url, reason: error instanceof Error ? error.message : 'Asset unavailable' })
            continue
          }
          if (kind === 'css' ? file.type !== 'text/css' : !file.type.startsWith('image/')) {
            manifest.excluded.push({ path: url, reason: 'Unexpected asset content type' })
            continue
          }
          const ext = kind === 'css' ? '.css' : new URL(url).pathname.match(/\.(png|jpe?g|gif|webp|svg|avif|ico)$/i)?.[0] ?? '.img'
          add(`assets/${++index}${ext}`, file.bytes, file.type, file.url)
        }
      }
      manifest.warnings.push('Static reference only: JavaScript was not executed; dynamic content and visual completeness are not guaranteed. CSS imports and nested assets were not crawled.')
    }
    manifest.files.sort((a, b) => a.path.localeCompare(b.path))
    return { manifest, contents }
  }
}
