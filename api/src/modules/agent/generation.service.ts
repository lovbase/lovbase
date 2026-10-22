import { ModelMeterService, type ModelContext } from '../billing/model-meter.service'
import type { LlmConfig } from '../llm/llm.service'
import { LimitsService } from '../limits/limits.service'
import { Injectable, Logger } from '@nestjs/common'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type pg from 'pg'
import { InjectPool } from '../../database/pool.provider'
import { ConfigService } from '../../config/config.service'
import { CreditsService } from '../credits/credits.service'
import { RatesService } from '../billing/rates.service'
import { LlmService } from '../llm/llm.service'
import { SandboxService } from '../sandbox/sandbox.service'
import type { Tier } from '@lovbase/core/billing'
import type { ObservedUsage } from './model-usage'
import { DomainError } from '../../common/errors'

type Run = {
  id: string
  user_id: string
  project_id: string
  app_id: string
  model: string
  tier: Tier
  byok: boolean
  status: string
}
@Injectable()
export class GenerationService {
  private readonly log = new Logger('generation-meter')
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly cfg: ConfigService,
    private readonly credits: CreditsService,
    private readonly rates: RatesService,
    private readonly llm: LlmService,
    private readonly sandbox: SandboxService,
    private readonly limits: LimitsService,
    private readonly models: ModelMeterService,
  ) {}
  modelFetch(cfg: LlmConfig, ctx: ModelContext) {
    return this.models.fetchFor(cfg, ctx)
  }
  private signature(text: string) {
    return createHmac('sha256', this.cfg.env.BETTER_AUTH_SECRET).update(text).digest('base64url')
  }
  async authorize(token: string): Promise<Run | null> {
    const [prefix, id, signature] = token.split('.')
    if (prefix !== 'lb_run' || !id || !signature) return null
    const expected = this.signature(id)
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
      return null
    const r = await this.pool.query(
      "SELECT * FROM public.lb_generation_runs WHERE id=$1 AND status='running' AND created_at>now()-interval '31 minutes'",
      [id],
    )
    return r.rows[0] ?? null
  }
  async run(
    userId: string,
    projectId: string,
    appId: string,
    prompt: string,
    tier?: Tier,
    onCharge?: (n: number) => void,
  ) {
    await this.limits.assertAccount(userId)
    await this.credits.assert(userId, 'build_app')
    const cfg = await this.llm.configFor(userId, tier)
    if (!cfg) throw new DomainError('No model configured')
    const id = randomUUID(),
      started = Date.now()
    await this.pool.query(
      'INSERT INTO public.lb_generation_runs(id,user_id,project_id,app_id,model,tier,byok) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, userId, projectId, appId, cfg.model, cfg.tier, cfg.source === 'user'],
    )
    try {
      const project = await this.pool.query('SELECT api_token FROM public.lb_projects WHERE id=$1', [projectId])
      return await this.sandbox.run(appId, {
        workspaceId: projectId,
        apiToken: project.rows[0].api_token,
        prompt,
        llm: { baseUrl: '/api/llm/v1', apiKey: `lb_run.${id}.${this.signature(id)}`, model: cfg.model },
      })
    } finally {
      const ms = Date.now() - started,
        container = await this.rates.forContainer(ms)
      await this.pool.query(
        `UPDATE public.lb_generation_runs SET status='finished',finished_at=now(),container_ms=$2,
        container_credits=$3,container_cost=$4 WHERE id=$1`,
        [id, ms, container.credits, container.costUsd],
      )
      await this.settleRun(id)
      const r = await this.pool.query(
        'SELECT coalesce(sum(credits),0)::int n FROM public.lb_model_requests WHERE run_id=$1',
        [id],
      )
      onCharge?.(container.credits + Number(r.rows[0].n))
    }
  }
  async beginRequest(run: Run) {
    await this.credits.assert(run.user_id, 'build_app')
    const id = randomUUID()
    await this.pool.query(
      'INSERT INTO public.lb_model_requests(id,run_id,user_id,project_id,model,byok) VALUES($1,$2,$3,$4,$5,$6)',
      [id, run.id, run.user_id, run.project_id, run.model, run.byok],
    )
    return id
  }
  async observe(id: string, run: Run, usage: ObservedUsage | null) {
    if (!usage) {
      await this.pool.query(
        "UPDATE public.lb_model_requests SET status='usage_missing' WHERE id=$1 AND status='pending'",
        [id],
      )
      this.log.warn(`Provider usage missing for request ${id}; no estimated model charge`)
      return
    }
    const price = await this.rates.forTokens(run.model, usage, run.byok, run.tier)
    await this.pool.query(
      `UPDATE public.lb_model_requests SET usage=$2,credits=$3,cost_usd=$4,status='measured'
      WHERE id=$1 AND status='pending'`,
      [id, JSON.stringify(usage), price.credits, price.costUsd],
    )
    await this.settleRequest(id)
  }
  private async settleRequest(id: string) {
    const r = await this.pool.query("SELECT * FROM public.lb_model_requests WHERE id=$1 AND status='measured'", [id]),
      row = r.rows[0]
    if (!row) return
    if (
      await this.credits.charge(row.user_id, {
        kind: row.kind ?? 'build_app',
        idempotencyKey: 'model:' + id,
        credits: row.credits,
        costUsd: row.cost_usd,
        usage: row.usage,
        byok: row.byok,
        projectId: row.project_id,
        model: row.model,
        note: 'Coding model usage',
      })
    )
      await this.pool.query("UPDATE public.lb_model_requests SET status='charged' WHERE id=$1", [id])
  }
  private async settleRun(id: string) {
    const r = await this.pool.query(
        'SELECT * FROM public.lb_generation_runs WHERE id=$1 AND container_ms IS NOT NULL',
        [id],
      ),
      row = r.rows[0]
    if (!row) return
    await this.credits.charge(row.user_id, {
      kind: 'build_app',
      idempotencyKey: 'container:' + id,
      credits: row.container_credits,
      costUsd: row.container_cost,
      containerMs: Number(row.container_ms),
      byok: row.byok,
      projectId: row.project_id,
      model: row.model,
      note: 'Measured container time',
    })
  }
  async reconcile() {
    for (const row of (
      await this.pool.query(
        "SELECT id FROM public.lb_model_requests WHERE status='measured' ORDER BY created_at LIMIT 100",
      )
    ).rows)
      await this.settleRequest(row.id)
    for (const row of (
      await this.pool
        .query(`SELECT g.id FROM public.lb_generation_runs g LEFT JOIN public.lb_credits c ON c.idempotency_key='container:'||g.id
      WHERE g.container_ms IS NOT NULL AND c.id IS NULL LIMIT 100`)
    ).rows)
      await this.settleRun(row.id)
    await this.pool.query(
      "UPDATE public.lb_model_requests SET status='usage_missing' WHERE status='pending' AND created_at<now()-interval '31 minutes'",
    )
    await this.pool.query(
      "UPDATE public.lb_generation_runs SET status='interrupted',finished_at=now() WHERE status='running' AND created_at<now()-interval '31 minutes'",
    )
  }
}
