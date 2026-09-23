import { beforeAll, describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { ConfigService } from '../src/config/config.service'
import { StorageService } from '../src/modules/storage/storage.service'
import { AttachmentsService, MAX_ATTACHMENT_BYTES, keyFor } from '../src/modules/storage/attachments.service'
import { ensureBucket, testConfig } from './s3-fixture'

// Same arrangement as storage.test.ts: real MinIO when one is pointed at, skipped otherwise.
//   S3_TEST_ENDPOINT=http://localhost:9200 S3_TEST_BUCKET=lovbase-uploads bun test attachments

const endpoint = process.env.S3_TEST_ENDPOINT

const service = (withStorage = true) =>
  new AttachmentsService(new StorageService(withStorage ? testConfig() : ConfigService.of({})))

const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
const msg = (parts: unknown[]): UIMessage => ({ id: 'm1', role: 'user', parts } as UIMessage)

describe('keyFor', () => {
  test('accepts our own served URLs', () => {
    expect(keyFor('/api/files/private/chat/p1/abc.png')).toBe('private/chat/p1/abc.png')
    expect(keyFor('/api/files/public/avatar/u1/abc.png')).toBe('public/avatar/u1/abc.png')
  })

  test('still accepts the shape attachments were written under before, which saved transcripts hold', () => {
    expect(keyFor('/api/files/projects/p1/abc.png')).toBe('projects/p1/abc.png')
  })

  test('rejects anything else, so a data URL is never mistaken for a key', () => {
    expect(keyFor(pngDataUrl)).toBeNull()
    expect(keyFor('https://evil.example/x')).toBeNull()
    expect(keyFor('/api/files/etc/passwd')).toBeNull()
  })

  test('refuses to climb out of the prefix', () => {
    expect(keyFor('/api/files/projects/../secrets/k')).toBeNull()
    expect(keyFor('/api/files/projects/p1/../../x')).toBeNull()
    expect(keyFor('/api/files/private/chat/p1/../../public/avatar/u/x')).toBeNull()
  })
})

describe('without storage configured', () => {
  test('messages pass through untouched, so attaching still works self-hosted', async () => {
    const s = service(false)
    const input = [msg([{ type: 'file', url: pngDataUrl, mediaType: 'image/png', filename: 'a.png' }])]
    expect(await s.offload('p1', input)).toBe(input)
    expect(await s.rehydrate(input)).toBe(input)
  })
})

describe.skipIf(!endpoint)('offload and rehydrate', () => {
  beforeAll(ensureBucket)

  test('a data URL goes to storage and the message keeps only a path', async () => {
    const s = service()
    const [out] = await s.offload('p-att', [msg([
      { type: 'text', text: 'look at this picture' },
      { type: 'file', url: pngDataUrl, mediaType: 'image/png', filename: 'a.png' },
    ])])
    const file = out.parts[1] as { url: string; filename: string }
    expect(file.url).toStartWith('/api/files/private/chat/p-att/')
    expect(file.url).toEndWith('.png')
    expect(file.filename).toBe('a.png')
    // The point of the whole exercise: no base64 left anywhere in what gets persisted.
    expect(JSON.stringify(out)).not.toContain('base64')
    expect(out.parts[0]).toEqual({ type: 'text', text: 'look at this picture' })
  })

  test('rehydrate brings the same bytes back for the model', async () => {
    const s = service()
    const [stored] = await s.offload('p-att', [msg([
      { type: 'file', url: pngDataUrl, mediaType: 'image/png', filename: 'a.png' },
    ])])
    const [back] = await s.rehydrate([stored])
    expect((back.parts[0] as { url: string }).url).toBe(pngDataUrl)
  })

  test('offload is idempotent: a stored URL is not re-uploaded', async () => {
    const s = service()
    const [once] = await s.offload('p-att', [msg([{ type: 'file', url: pngDataUrl, mediaType: 'image/png', filename: 'a.png' }])])
    const [twice] = await s.offload('p-att', [once])
    expect((twice.parts[0] as { url: string }).url).toBe((once.parts[0] as { url: string }).url)
  })

  test('a file over the cap becomes a note instead of a stored object', async () => {
    const s = service()
    const big = `data:image/png;base64,${btoa('x'.repeat(MAX_ATTACHMENT_BYTES + 10))}`
    const [out] = await s.offload('p-att', [msg([{ type: 'file', url: big, mediaType: 'image/png', filename: 'big.png' }])])
    expect(out.parts[0]).toEqual({ type: 'text', text: '[Attachment big.png is over 8MB and was skipped]' })
  })

  test('an attachment that has been deleted degrades to a note, not a crash', async () => {
    const s = service()
    const [back] = await s.rehydrate([msg([
      { type: 'file', url: '/api/files/projects/p-att/gone.png', mediaType: 'image/png', filename: 'gone.png' },
    ])])
    expect(back.parts[0]).toEqual({ type: 'text', text: '[Attachment gone.png no longer exists]' })
  })

  test('a text file round-trips byte for byte', async () => {
    const s = service()
    // Deliberately non-ASCII: the round trip has to survive multi-byte characters, not just ASCII.
    const csv = 'name,qty\n李雷,3\n'
    const url = `data:text/csv;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(csv)))}`
    const [stored] = await s.offload('p-att', [msg([{ type: 'file', url, mediaType: 'text/csv', filename: 'd.csv' }])])
    const [back] = await s.rehydrate([stored])
    const b64 = (back.parts[0] as { url: string }).url.split(',')[1]
    expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).toBe(csv)
  })

  test('deleteProject sweeps that project and leaves others alone', async () => {
    const s = service()
    const keep = await s.offload('p-keep', [msg([{ type: 'file', url: pngDataUrl, mediaType: 'image/png', filename: 'k.png' }])])
    await s.offload('p-drop', [msg([{ type: 'file', url: pngDataUrl, mediaType: 'image/png', filename: 'd.png' }])])
    expect(await s.deleteProject('p-drop')).toBeGreaterThan(0)
    const [still] = await s.rehydrate(keep)
    expect((still.parts[0] as { url: string }).url).toBe(pngDataUrl)
    await s.deleteProject('p-keep')
  })
})
