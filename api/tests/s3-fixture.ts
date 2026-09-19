import { ConfigService } from '../src/config/config.service'
import { StorageService } from '../src/modules/storage/storage.service'

// Shared setup for the two suites that talk to a real S3 server.
//
// Both need the bucket to exist, and neither may assume the other ran first — bun runs files
// concurrently, so "one test creates it and the rest rely on that" is a suite that passes on a
// warm server and fails on a cold one. Creating it from here, idempotently, removes the ordering
// dependency and means CI needs nothing installed beyond the server itself.

export const S3_ENDPOINT = process.env.S3_TEST_ENDPOINT
export const S3_BUCKET = process.env.S3_TEST_BUCKET ?? 'lovbase-test'

export const testConfig = () => ConfigService.of({
  S3_ENDPOINT,
  S3_BUCKET,
  S3_ACCESS_KEY_ID: process.env.S3_TEST_KEY ?? 'lovbase',
  S3_SECRET_ACCESS_KEY: process.env.S3_TEST_SECRET ?? 'lovbase123',
  S3_REGION: process.env.S3_TEST_REGION ?? 'us-east-1',
})

export const testStorage = () => new StorageService(testConfig())

/**
 * Create the bucket if it is not there. The app itself never does this — in production a bucket
 * is made once in a dashboard and the credentials are not allowed to make more — so it belongs in
 * the fixture rather than in the code under test.
 */
export async function ensureBucket(): Promise<void> {
  if (!S3_ENDPOINT) return
  const aws = (testStorage() as unknown as { aws: { fetch: typeof fetch } }).aws
  const res = await aws.fetch(`${S3_ENDPOINT.replace(/\/+$/, '')}/${S3_BUCKET}`, { method: 'PUT' })
  // 409 is BucketAlreadyOwnedByYou; R2 answers 200 for a bucket that already exists.
  if (![200, 409].includes(res.status)) {
    throw new Error(`could not create test bucket ${S3_BUCKET}: ${res.status} ${await res.text().catch(() => '')}`)
  }
}
