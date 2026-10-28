import 'reflect-metadata'
import { describe, expect, test } from 'bun:test'
import { ModelMeterService } from '../src/modules/billing/model-meter.service'
import { OutOfCredits, isOutOfCredits } from '../src/modules/credits/credits.service'
import { GenerationService } from '../src/modules/agent/generation.service'
import { TurnService } from '../src/modules/agent/turn.service'
import { WorkerRuntimeService } from '../src/modules/jobs/worker-runtime.service'
import { SandboxService } from '../src/modules/sandbox/sandbox.service'

const exhausted = () => new OutOfCredits({ left: 0 } as any)
const log = { log() {}, warn() {}, error() {} }

test('model paywall latches before SDK retries, including after a top-up', async () => {
  let latched = false, checks = 0, requests = 0
  const jobs = { creditExhausted: async () => latched, markCreditExhausted: async () => { latched = true } }
  const meter = new ModelMeterService({ query: async () => { requests++ } } as any,
    { assert: async () => { checks++; throw exhausted() } } as any, {} as any, {} as any, jobs as any)
  const send = meter.fetchFor({ source: 'platform' } as any, { userId: 'u', projectId: 'p', runId: 'r' })
  await expect(send('https://unused.invalid')).rejects.toThrow('Credits used up')
  await expect(send('https://unused.invalid')).rejects.toThrow('out_of_credits')
  expect(latched).toBe(true)
  expect(checks).toBe(1)
  expect(requests).toBe(0)
  expect(isOutOfCredits(new Error('wrapped', { cause: exhausted() }))).toBe(true)
  expect(isOutOfCredits(new Error('Account storage limit reached'))).toBe(false)
})

test('Boris paywall stops the detached agent and records the parent before returning', async () => {
  const calls: string[] = []
  const generation = new GenerationService({ query: async () => { calls.push('request') } } as any, {} as any,
    { assert: async () => { throw exhausted() } } as any, {} as any, {} as any,
    { stopRun: async (app: string, reason: string) => { calls.push(`stop:${app}:${reason}`) } } as any,
    {} as any, {} as any,
    { creditExhausted: async () => false, markCreditExhausted: async (id: string) => { calls.push(`latch:${id}`) } } as any)
  await expect(generation.beginRequest({ id: 'child', app_id: 'a', user_id: 'u' } as any)).rejects.toThrow('Credits used up')
  expect(calls).toEqual(['latch:child', 'stop:a:out_of_credits'])
})

test('stream error parts remain errors even when the SDK finishes the stream normally', async () => {
  const agent = { prepare: () => async () => {}, stream: async () => ({
    toUIMessageStream: (options: any) => new ReadableStream({ async start(c) {
      c.enqueue({ type: 'start', messageId: 'a' })
      c.enqueue({ type: 'error', errorText: options.onError(exhausted()) })
      await options.onFinish({ messages: [{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Partial work' }] }] })
      c.close()
    } }),
  }) }
  const conversation = { saveChat: async () => {}, sealChat: async () => {}, endRun: async () => {}, touchRun: async () => {} }
  const service = new TurnService(agent as any, conversation as any,
    { capture: async (_id: string, stream: ReadableStream) => { for await (const _ of stream) {} } } as any,
    { summarizeRun: async () => ({}) } as any)
  Object.assign(service, { persist: async (stream: ReadableStream) => { for await (const _ of stream) {} } })
  const live = await service.start({ runId: 'r', project: { id: 'p' }, app: { id: 'a' }, userId: 'u',
    cfg: {}, stored: [], forModel: [], pricer: {}, byok: false } as any)
  await live.done
  expect(live.outOfCredits).toBe(true)
  expect(live.error).not.toBeNull()
  expect(live.chatSaved).toBe(true)
})

function recoveryFixture(result: any = { ok: true }, options: { sourceFail?: boolean; hadPreview?: boolean; current?: boolean } = {}) {
  const calls: string[] = [], updates: any[] = []
  let final: any
  const worker = Object.create(WorkerRuntimeService.prototype) as any
  Object.assign(worker, {
    workerId: 'w', log, cfg: { snapshotsConfigured: true },
    jobs: {
      markFinalizing: async () => { calls.push('finalizing') },
      updateRecovery: async (_id: string, value: any) => { updates.push(structuredClone(value)) },
      finish: async (...args: any[]) => { final = args; calls.push('finished') },
    },
    conversation: { sealChat: async () => { calls.push('sealed') } },
    apps: {
      get: async () => ({ snap_at: options.hadPreview === false ? null : new Date() }),
      versions: async () => ({ sourceVersion: 2, snapshotVersion: options.current ? 2 : 1 }),
      saveSnapshot: async () => { calls.push('durable'); if (options.sourceFail) throw new Error('Storage unavailable') },
      markSnapshotted: async () => { calls.push('snapshot marked') },
      markRuntime: async () => { calls.push('snapshot failed') },
    },
    sandbox: {
      snapshot: async (_id: string, save: Function) => { calls.push('source export'); await save([{ path: 'src/App.tsx', content: 'partial work' }]) },
      snapshotBuild: async (_id: string, budget: number) => { calls.push(`preview:${budget}`); return result },
    },
  })
  return { calls, updates, final: () => final, run: (touched = true, chatSaved = true) => worker.finishCreditExhaustion({ id: 'j', run_id: 'r', project_id: 'p', app_id: 'a' }, touched, chatSaved) }
}

describe('credit recovery settlement', () => {
  test('source and tools are saved before the preview; no cover or live preview is required', async () => {
    const f = recoveryFixture()
    await f.run()
    expect(f.calls).toEqual(['finalizing', 'sealed', 'source export', 'durable', 'preview:30000', 'snapshot marked', 'finished'])
    expect(f.updates[0]).toMatchObject({ sourceStatus: 'saving', terminationReason: 'out_of_credits' })
    expect(f.updates[1]).toMatchObject({ sourceStatus: 'saved', previewStatus: 'saving' })
    expect(f.final()).toMatchObject(['j', 'interrupted', 'out_of_credits', { sourceStatus: 'saved', previewStatus: 'ready' }])
  })
  for (const [result, previewStatus] of [[{ ok: false, timedOut: true }, 'timed_out'], [{ ok: false }, 'failed']] as const) {
    test(`preview ${previewStatus} keeps the saved source and old preview`, async () => {
      const f = recoveryFixture(result)
      await f.run()
      expect(f.final()[3]).toMatchObject({ sourceStatus: 'saved', hadPreview: true, previewStatus })
      expect(f.calls).not.toContain('snapshot marked')
      expect(f.calls.filter(c => c.startsWith('preview:'))).toHaveLength(1)
    })
  }
  test('rollback failure never claims that the old preview is usable', async () => {
    const f = recoveryFixture({ ok: false, cleanupFailed: true })
    await f.run()
    expect(f.final()[3]).toMatchObject({ sourceStatus: 'saved', hadPreview: false, previewStatus: 'failed' })
    expect(f.calls).toContain('snapshot failed')
  })
  test('source or transcript save failure cannot announce saved changes or start a build', async () => {
    const transcript = recoveryFixture()
    await transcript.run(true, false)
    expect(transcript.final()[3].sourceStatus).toBe('failed')
    expect(transcript.calls).toContain('durable')
    expect(transcript.calls).not.toContain('preview:30000')
    const source = recoveryFixture({ ok: true }, { sourceFail: true })
    await source.run()
    expect(source.calls).toContain('durable')
    expect(source.final()[3].sourceStatus).toBe('failed')
    expect(source.calls).not.toContain('preview:30000')
  })
  test('first-request rejection and unchanged snapshots skip preview building', async () => {
    const untouched = recoveryFixture()
    await untouched.run(false)
    expect(untouched.calls).not.toContain('source export')
    expect(untouched.calls).not.toContain('preview:30000')
    const current = recoveryFixture({ ok: true }, { current: true })
    await current.run()
    expect(current.calls).not.toContain('preview:30000')
    expect(current.final()[3].previewStatus).toBe('ready')
  })
})

test('source snapshot rejects incomplete exports and storage failures instead of reporting success', async () => {
  const service = Object.create(SandboxService.prototype) as any
  Object.assign(service, { log, exportFiles: async () => ({ files: [] }) })
  await expect(service.snapshot('a', async () => {})).rejects.toThrow('no files')
  service.exportFiles = async () => ({ files: [{ path: 'a', content: 'b' }] })
  await expect(service.snapshot('a', async () => { throw new Error('Storage unavailable') })).rejects.toThrow('Storage unavailable')
})
