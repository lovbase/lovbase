import { expect, test } from 'bun:test'
import { transferFiles } from '../src/build-transfer'

test('failed concurrent uploads settle before rollback starts', async () => {
  const events: string[] = []
  let release!: () => void
  const slow = new Promise<void>(resolve => { release = resolve })
  const transfer = transferFiles([1,2,3],async file => {
    events.push(`start:${file}`)
    if (file === 1) throw new Error('upload failed')
    await slow
    events.push(`end:${file}`)
  },2).catch(() => {events.push('rollback')})
  await Promise.resolve(); await Promise.resolve()
  expect(events).toEqual(['start:1','start:2'])
  release(); await transfer
  expect(events).toEqual(['start:1','start:2','end:2','rollback'])
})
