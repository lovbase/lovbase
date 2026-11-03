import { expect, test } from 'bun:test'
import { snapshotHost, verifySnapshotHost } from '../src/snapshot-auth'

const HALF_HOUR = 1800_000

test('the same snapshot host is handed out for up to half an hour, so cached assets survive a reload', async () => {
  const slotStart = Math.floor(Date.now() / HALF_HOUR) * HALF_HOUR
  const early = await snapshotHost('b123456789ab', 'test-secret', slotStart + 1_000)
  const late = await snapshotHost('b123456789ab', 'test-secret', slotStart + HALF_HOUR - 1_000)
  expect(late).toBe(early)
  expect(await snapshotHost('b123456789ab', 'test-secret', slotStart + HALF_HOUR + 1_000)).not.toBe(early)
})

test('every snapshot host stays valid for at least thirty minutes and never for more than an hour', async () => {
  const slotStart = Math.floor(Date.now() / HALF_HOUR) * HALF_HOUR
  for (const minted of [slotStart, slotStart + HALF_HOUR / 2, slotStart + HALF_HOUR - 1]) {
    const host = await snapshotHost('b123456789ab', 'test-secret', minted)
    expect(await verifySnapshotHost(host, 'test-secret', minted)).toBe('b123456789ab')
    expect(await verifySnapshotHost(host, 'test-secret', minted + HALF_HOUR - 1_000)).toBe('b123456789ab')
    expect(await verifySnapshotHost(host, 'test-secret', minted + 3600_000)).toBeNull()
  }
})
