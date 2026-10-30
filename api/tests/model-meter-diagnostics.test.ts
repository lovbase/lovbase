import 'reflect-metadata'
import { afterAll, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { ModelMeterService } from '../src/modules/billing/model-meter.service'
import { RatesService } from '../src/modules/billing/rates.service'

const db = new PGlite()
afterAll(() => db.close())

test('turn ledger includes delegated models and container costs exactly once, with user isolation', async () => {
  await db.exec(`CREATE TABLE lb_generation_runs(id text,parent_run_id text,user_id text,container_credits int,container_cost float8,container_ms bigint);
    CREATE TABLE lb_model_requests(run_id text,user_id text,usage jsonb,credits int,cost_usd float8,pricing jsonb);
    INSERT INTO lb_generation_runs VALUES ('child','turn','u',2,0.01,30000),('foreign','turn','other',1000,10,1);
    INSERT INTO lb_model_requests VALUES
      ('turn','u','{"inTokens":1000,"outTokens":50,"cachedTokens":800}',3,0.02,'{"fallback":false}'),
      ('child','u','{"inTokens":2000,"outTokens":100,"cachedTokens":1500}',5,0.03,'{"fallback":true}'),
      ('turn','u',null,0,0,null),
      ('unrelated','u','{"inTokens":999999}',900,9,null),
      ('turn','other','{"inTokens":999999}',900,9,null);`)
  const meter = new ModelMeterService({ query: (sql: string, params: any[]) => db.query(sql, params) } as any, {} as any, {} as any, {} as any)
  expect(await meter.summarizeRun('turn', 'u')).toEqual({
    runId: 'turn', requests: 3, unmeasuredRequests: 1, inTokens: 3000, outTokens: 150, cachedTokens: 2300,
    modelCredits: 8, containerCredits: 2, credits: 10, modelCostUsd: 0.05, containerCostUsd: 0.01, containerMs: 30000, fallbackRequests: 1,
  })
  expect(await meter.summarizeRun('missing', 'u')).toMatchObject({ requests: 0, credits: 0, cachedTokens: 0 })
})

test('pricing diagnostics distinguish fallback and configured cache rates without changing prices', async () => {
  const rates = new RatesService({ get: async () => ({ models: { configured: { tier: 'standard', inPer1M: 3, outPer1M: 15, cachedInPer1M: 0.3 } } }) } as any)
  const configured = await rates.pricerFor('configured')
  expect(configured.pricing).toEqual({ fallback: false, margin: 1.5, rate: { tier: 'standard', inPer1M: 3, outPer1M: 15, cachedInPer1M: 0.3 } })
  expect(configured.charge({ inTokens: 1000000, outTokens: 0, cachedTokens: 1000000 }, false)).toEqual({ tier: 'standard', credits: 45, costUsd: 0.3 })
  const fallback = await rates.pricerFor('unknown', 'standard')
  expect(fallback.pricing).toMatchObject({ fallback: true, margin: 1.5, rate: { inPer1M: 15, outPer1M: 75 } })
  expect(fallback.charge({ inTokens: 1000000, outTokens: 0, cachedTokens: 1000000 }, false).costUsd).toBe(15)
})

test('deployed GPT models resolve cache-aware defaults while custom gateway prices still win', async () => {
  const defaults = new RatesService({ get: async () => null } as any)
  for (const model of ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']) {
    const pricer = await defaults.pricerFor(model)
    expect(pricer.pricing.fallback).toBe(false)
    expect(pricer.pricing.rate.cachedInPer1M).toBeDefined()
  }
  const astra = await defaults.pricerFor('gpt-6-astra', 'advanced')
  expect(astra.charge({ inTokens: 48_530, outTokens: 624, cachedTokens: 48_256 }, false)).toEqual({
    tier: 'advanced', credits: 15, costUsd: 0.082196,
  })
  expect(astra.charge({ inTokens: 48_530, outTokens: 624, cachedTokens: 48_256 }, true).credits).toBe(0)

  const gateway = new RatesService({ get: async () => ({ models: {
    'gpt-6-astra': { tier: 'advanced', inPer1M: 20, outPer1M: 100, cachedInPer1M: 2 },
  } }) } as any)
  expect((await gateway.pricerFor('gpt-6-astra')).pricing.rate.inPer1M).toBe(20)
})
