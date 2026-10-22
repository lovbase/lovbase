import { LimitsService } from '../limits/limits.service'
import { Forbidden } from '../../common/errors'
import { Injectable, Logger } from '@nestjs/common'
import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { InjectPool } from '../../database/pool.provider'
import { CreditsService } from '../credits/credits.service'
import { RatesService } from './rates.service'
import { usageObserver } from '../agent/model-usage'
import type { LlmConfig } from '../llm/llm.service'

export type ModelContext = { userId: string; projectId: string; runId: string; onCharge?: (credits: number) => void }

/** The same measured, durable request ledger for chat, schema retries and internal completions. */
@Injectable()
export class ModelMeterService {
  private readonly log = new Logger('model-meter')
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly credits: CreditsService,
    private readonly rates: RatesService,
    private readonly limits: LimitsService,
  ) {}

  fetchFor(cfg: LlmConfig, ctx: ModelContext): typeof fetch {
    return async (input, init) => {
      if (cfg.source === 'user' && !(await this.limits.plan(ctx.userId)).byok)
        throw new Forbidden('BYOK entitlement expired')
      await this.credits.assert(ctx.userId, 'message')
      const id = randomUUID(),
        byok = cfg.source === 'user'
      const pricer = await this.rates.pricerFor(cfg.model, cfg.tier)
      await this.pool.query(
        `INSERT INTO public.lb_model_requests(id,run_id,user_id,project_id,model,byok,kind)
        VALUES($1,$2,$3,$4,$5,$6,'message')`,
        [id, ctx.runId, ctx.userId, ctx.projectId, cfg.model, byok],
      )
      let measured = false
      const record = async (usage: Parameters<Parameters<typeof usageObserver>[1]>[0]) => {
        if (measured) return
        measured = true
        if (!usage) {
          await this.pool.query(
            "UPDATE public.lb_model_requests SET status='usage_missing' WHERE id=$1 AND status='pending'",
            [id],
          )
          this.log.warn(`Provider usage missing for request ${id}; no estimated charge`)
          return
        }
        const charge = pricer.charge(usage, byok)
        await this.pool.query(
          `UPDATE public.lb_model_requests SET usage=$2,credits=$3,cost_usd=$4,status='measured'
          WHERE id=$1 AND status='pending'`,
          [id, JSON.stringify(usage), charge.credits, charge.costUsd],
        )
        // If the ledger debit fails, the measured row is retried by the minute reconciler.
        try {
          const charged = await this.credits.charge(ctx.userId, {
            kind: 'message',
            idempotencyKey: 'model:' + id,
            credits: charge.credits,
            costUsd: charge.costUsd,
            usage,
            byok,
            projectId: ctx.projectId,
            model: cfg.model,
          })
          if (charged) await this.pool.query("UPDATE public.lb_model_requests SET status='charged' WHERE id=$1", [id])
        } catch {
          this.log.error(`Request ${id} debit pending reconciliation`)
        }
        ctx.onCharge?.(charge.credits)
      }
      try {
        if (typeof init?.body === 'string') {
          const body = JSON.parse(init.body)
          if (body.stream) body.stream_options = { ...body.stream_options, include_usage: true }
          init = { ...init, body: JSON.stringify(body) }
        }
        const response = await fetch(input, init)
        if (!response.ok || !response.body) {
          await record(null)
          return response
        }
        const reader = response.body
          .pipeThrough(usageObserver(response.headers.get('content-type') ?? '', record))
          .getReader()
        const headers = new Headers(response.headers)
        headers.delete('content-length')
        headers.delete('content-encoding')
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read()
              if (chunk.done) controller.close()
              else controller.enqueue(chunk.value)
            } catch (error) {
              await record(null)
              controller.error(error)
            }
          },
          async cancel(reason) {
            await reader.cancel(reason)
            await record(null)
          },
        })
        return new Response(body, { status: response.status, statusText: response.statusText, headers })
      } catch (error) {
        await record(null)
        throw error
      }
    }
  }
}
