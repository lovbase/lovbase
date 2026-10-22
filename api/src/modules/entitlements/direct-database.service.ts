import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { randomBytes } from 'node:crypto'
import { InjectPool } from '../../database/pool.provider'
import { ConfigService } from '../../config/config.service'
import { SchemaService } from '../../database/schema.service'
import { LimitsService } from '../limits/limits.service'
import { Forbidden, DomainError } from '../../common/errors'
import { qi } from '@lovbase/core/ddl'
import { effectivePlan } from '@lovbase/core/billing'
import type { ProjectCtx } from '../auth/access.service'

const literal = (s: string) => "'" + s.replace(/'/g, "''") + "'"
export const directRole = (projectId: string) => 'ro_' + projectId

@Injectable()
export class DirectDatabaseService {
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly cfg: ConfigService,
    private readonly schema: SchemaService,
    private readonly limits: LimitsService,
  ) {}
  get configured() {
    return !!this.cfg.env.DATABASE_PUBLIC_HOST
  }
  async info(ctx: ProjectCtx) {
    await this.schema.ready()
    const plan = await this.limits.plan(ctx.user.id)
    if (!plan.directDatabase) throw new Forbidden('Pro is required for direct database access')
    const r = await this.pool.query('SELECT enabled,updated_at FROM public.lb_direct_connections WHERE project_id=$1', [
      ctx.project.id,
    ])
    return {
      configured: this.configured,
      enabled: !!r.rows[0]?.enabled,
      host: this.cfg.env.DATABASE_PUBLIC_HOST ?? '',
      port: this.cfg.env.DATABASE_PUBLIC_PORT,
      database: this.cfg.env.DATABASE_PUBLIC_NAME ?? new URL(this.cfg.env.DATABASE_URL).pathname.slice(1),
      sslmode: this.cfg.env.DATABASE_PUBLIC_SSLMODE,
      username: directRole(ctx.project.id),
      schema: 'p_' + ctx.project.id,
    }
  }
  async create(ctx: ProjectCtx) {
    await this.info(ctx)
    if (!this.configured) throw new DomainError('External database address is not configured')
    const password = randomBytes(24).toString('base64url'),
      role = directRole(ctx.project.id),
      schema = 'p_' + ctx.project.id
    await this.limits.transaction(ctx.user.id, async (db) => {
      if (!(await this.limits.plan(ctx.user.id, db)).directDatabase) throw new Forbidden('Pro required')
      const exists = await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])
      if (!exists.rowCount)
        await db.query(
          `CREATE ROLE ${qi(role)} NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER NOREPLICATION NOBYPASSRLS`,
        )
      await db.query(`GRANT USAGE ON SCHEMA ${qi(schema)} TO ${qi(role)}`)
      await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${qi(schema)} TO ${qi(role)}`)
      await db.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA ${qi(schema)} GRANT SELECT ON TABLES TO ${qi(role)}`,
      )
      const account = await db.query('SELECT stripe_paid_until,stripe_subscription_id FROM public."user" WHERE id=$1', [
        ctx.user.id,
      ])
      const until = account.rows[0]?.stripe_subscription_id
        ? new Date(account.rows[0].stripe_paid_until).toISOString()
        : 'infinity'
      await db.query(
        `ALTER ROLE ${qi(role)} LOGIN PASSWORD ${literal(password)} VALID UNTIL ${literal(until)} CONNECTION LIMIT 3`,
      )
      await db.query(`ALTER ROLE ${qi(role)} SET search_path = ${qi(schema)}, pg_catalog`)
      await db.query(`ALTER ROLE ${qi(role)} SET statement_timeout = '30s'`)
      await db.query(`ALTER ROLE ${qi(role)} SET default_transaction_read_only = on`)
      await db.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()',
        [role],
      )
      await db.query(
        `INSERT INTO public.lb_direct_connections(project_id,role_name,enabled) VALUES($1,$2,true)
        ON CONFLICT(project_id) DO UPDATE SET enabled=true,updated_at=now()`,
        [ctx.project.id, role],
      )
    })
    return { ...(await this.info(ctx)), password }
  }
  async revoke(ctx: ProjectCtx) {
    await this.disable(ctx.project.id)
    return { ok: true }
  }
  private async disable(projectId: string) {
    const role = directRole(projectId)
    const r = await this.pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])
    if (r.rowCount) {
      await this.pool.query(`ALTER ROLE ${qi(role)} NOLOGIN PASSWORD NULL`)
      await this.pool.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()',
        [role],
      )
    }
    await this.pool.query(
      'UPDATE public.lb_direct_connections SET enabled=false,updated_at=now() WHERE project_id=$1',
      [projectId],
    )
  }
  async reconcile(userId?: string) {
    await this.schema.ready()
    const r = await this.pool.query(
      `SELECT u.*,d.project_id,d.role_name FROM public.lb_direct_connections d
      JOIN public.lb_projects p ON p.id=d.project_id JOIN public."user" u ON u.id=p.owner_id
      WHERE d.enabled AND ($1::text IS NULL OR u.id=$1)`,
      [userId ?? null],
    )
    for (const row of r.rows) {
      if (effectivePlan(row) === 'free') await this.disable(row.project_id)
      else if (row.stripe_subscription_id && row.stripe_paid_until)
        await this.pool.query(
          `ALTER ROLE ${qi(row.role_name)} VALID UNTIL ${literal(new Date(row.stripe_paid_until).toISOString())}`,
        )
    }
  }
}
