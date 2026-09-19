import { describe, expect, test } from 'bun:test'
import { ConfigService } from '../src/config/config.service'
import { StorageService, attachmentKey } from '../src/modules/storage/storage.service'

// These run against a real S3 server when one is pointed at, and skip otherwise, because the thing
// worth testing here is SigV4 against a real implementation — a mock would only assert that the
// code calls the code. MinIO is the stand-in for R2: both speak the same API, which is the whole
// reason one adapter can serve the hosted and self-hosted products.
//
//   docker run -d -p 9123:9000 -e MINIO_ROOT_USER=lovbase -e MINIO_ROOT_PASSWORD=lovbase123 \
//     quay.io/minio/minio server /data
//   S3_TEST_ENDPOINT=http://localhost:9123 bun test storage

const endpoint = process.env.S3_TEST_ENDPOINT
const bucket = process.env.S3_TEST_BUCKET ?? 'lovbase-test'

const storage = () =>
  new StorageService(ConfigService.of({
    S3_ENDPOINT: endpoint,
    S3_BUCKET: bucket,
    S3_ACCESS_KEY_ID: process.env.S3_TEST_KEY ?? 'lovbase',
    S3_SECRET_ACCESS_KEY: process.env.S3_TEST_SECRET ?? 'lovbase123',
    S3_REGION: 'us-east-1',
  }))

describe('attachmentKey', () => {
  test('files land under their project, so deleting one can sweep them all', () => {
    expect(attachmentKey('p1', 'abc', 'shot.png')).toBe('projects/p1/abc.png')
  })

  test('keeps the extension, lowercased, and copes with none', () => {
    expect(attachmentKey('p1', 'abc', 'DATA.CSV')).toBe('projects/p1/abc.csv')
    expect(attachmentKey('p1', 'abc')).toBe('projects/p1/abc')
    expect(attachmentKey('p1', 'abc', 'no-extension')).toBe('projects/p1/abc')
  })

  test('a name that is mostly dots does not become the extension', () => {
    expect(attachmentKey('p1', 'abc', 'archive.tar.gz')).toBe('projects/p1/abc.gz')
  })
})

describe('storage is off until it is configured', () => {
  test('no endpoint means disabled, and nothing else has to check three variables', () => {
    expect(new StorageService(ConfigService.of({})).enabled).toBe(false)
    expect(new StorageService(ConfigService.of({ S3_ENDPOINT: 'http://x' })).enabled).toBe(false)
  })

  test('all three present means enabled', () => {
    expect(storage().enabled).toBe(endpoint ? true : false)
  })
})

describe.skipIf(!endpoint)('against a real S3 server', () => {
  test('a bucket that exists is a precondition, not something the app creates', async () => {
    // The app never creates buckets: in production that is a Terraform/dashboard concern and the
    // credentials should not be allowed to. Create it here so the rest of the suite has one.
    const s = storage()
    const res = await (s as any).aws.fetch(`${endpoint}/${bucket}`, { method: 'PUT' })
    expect([200, 409]).toContain(res.status) // 409 = BucketAlreadyOwnedByYou
  })

  test('round-trips bytes with their content type', async () => {
    const s = storage()
    const key = attachmentKey('p-test', `rt-${Date.now()}`, 'a.png')
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    await s.put(key, bytes, 'image/png')
    const got = await s.get(key)
    expect(got).not.toBeNull()
    expect([...got!.bytes]).toEqual([...bytes])
    expect(got!.contentType).toBe('image/png')
    await s.delete(key)
  })

  test('a missing object reads as null, so a deleted file cannot break a transcript', async () => {
    expect(await storage().get('projects/p-test/definitely-not-here')).toBeNull()
  })

  test('deleting something already gone is not an error', async () => {
    await storage().delete('projects/p-test/never-existed')
  })

  test('a key with spaces and unicode survives the signature', async () => {
    const s = storage()
    const key = attachmentKey('p-test', `名前 with spaces ${Date.now()}`, 'x.csv')
    await s.put(key, new TextEncoder().encode('a,b\n1,2\n'), 'text/csv')
    expect(new TextDecoder().decode((await s.get(key))!.bytes)).toBe('a,b\n1,2\n')
    await s.delete(key)
  })

  test('deletePrefix removes a whole project and reports how many', async () => {
    const s = storage()
    const pid = `sweep-${Date.now()}`
    for (const n of ['one.txt', 'two.txt', 'three.txt'])
      await s.put(attachmentKey(pid, n, n), new TextEncoder().encode(n), 'text/plain')
    expect(await s.deletePrefix(`projects/${pid}/`)).toBe(3)
    expect(await s.get(attachmentKey(pid, 'one.txt', 'one.txt'))).toBeNull()
  })
})
