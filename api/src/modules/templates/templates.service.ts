import { effectivePlan } from '@lovbase/core/billing'
import { LimitsService } from '../limits/limits.service'
import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { z } from 'zod'
import { planOf } from '@lovbase/core/plans'
import type { TemplateId } from '@lovbase/core/templates'
import { qi } from '@lovbase/core/ddl'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { RolesService, schemaFor, roleFor, SQL_ROLE } from '../roles/roles.service'
import { randomId } from '../../common/ids'
import { DomainError, NotFound, PlanLimit } from '../../common/errors'
import { templateDefinition } from './registry'

export const remixInput = z.object({
  templateId: z.enum(['inventory', 'product-3d', 'inkwave']),
  version: z.literal(1),
  name: z.string().trim().min(1).max(80),
  locale: z.enum(['zh', 'en']),
  requestId: z.string().uuid(),
})
export type RemixInput = z.infer<typeof remixInput>
export const DEMO_PROJECT = 'templateinventoryv1'

@Injectable()
export class TemplatesService {
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly schema: SchemaService,
    private readonly roles: RolesService,
    private readonly limits: LimitsService,
  ) {}

  async create(userId: string, raw: RemixInput) {
    const input = remixInput.parse(raw)
    const template = templateDefinition(input.templateId, input.version)
    await this.schema.ready()
    await this.roles.ensureExecutorRole()
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN')
      // Also taken by ordinary blank-project creation: the quota boundary is shared.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['projects:' + userId])
      const prior = await c.query(
        'SELECT * FROM public.lb_template_instances WHERE user_id=$1 AND request_id=$2',
        [userId, input.requestId],
      )
      if (prior.rows[0]) {
        if (
          prior.rows[0].template_id !== input.templateId ||
          prior.rows[0].version !== input.version
        )
          throw new DomainError('request_conflict')
        await c.query('COMMIT')
        return {
          projectId: prior.rows[0].project_id as string,
          appId: prior.rows[0].project_id as string,
        }
      }
      const account = await c.query('SELECT * FROM public."user" WHERE id=$1', [userId])
      if (!account.rows[0]) throw new NotFound('Account not found')
      const count = await c.query(
        'SELECT count(*)::int AS n FROM public.lb_projects WHERE owner_id=$1',
        [userId],
      )
      if (count.rows[0].n >= planOf(effectivePlan(account.rows[0])).projects)
        throw new PlanLimit('Project limit reached')
      await this.limits.lock(c, userId)
      await this.limits.assertAccount(userId, c)
      const id = 'a' + randomId(11)
      await this.initialize(
        c,
        id,
        userId,
        input.name,
        input.locale,
        false,
        input.requestId,
        template,
      )
      await this.limits.assertAccount(userId, c)
      await c.query('COMMIT')
      return { projectId: id, appId: id }
    } catch (err) {
      await c.query('ROLLBACK')
      throw err
    } finally {
      c.release()
    }
  }

  async ensureDemo(templateId: TemplateId = 'inventory', version = 1): Promise<string> {
    const template = templateDefinition(templateId, version)
    const demoId = template.demoId
    await this.schema.ready()
    await this.roles.ensureExecutorRole()
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN')
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [demoId])
      const exists = await c.query(
        'SELECT 1 FROM public.lb_template_instances WHERE project_id=$1 AND demo=true',
        [demoId],
      )
      if (!exists.rowCount)
        await this.initialize(
          c,
          demoId,
          '__templates__',
          template.name.en,
          'en',
          true,
          `${template.id}-v${template.version}`,
          template,
        )
      await c.query('COMMIT')
      return demoId
    } catch (err) {
      await c.query('ROLLBACK')
      throw err
    } finally {
      c.release()
    }
  }

  private async initialize(
    c: pg.PoolClient,
    id: string,
    userId: string,
    name: string,
    locale: string,
    demo: boolean,
    requestId: string,
    template: ReturnType<typeof templateDefinition>,
  ) {
    const schema = schemaFor(id)
    const role = qi(roleFor(id))
    await c.query(
      `INSERT INTO public.lb_projects(id,owner_id,name,ir,api_token,read_only) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        id,
        userId,
        name,
        JSON.stringify({ ...template.ir, appName: name }),
        demo ? null : 'lb_' + randomId(32),
        demo,
      ],
    )
    await template.install(c, schema)
    await template.seed(c, schema)
    await c.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT`)
    await c.query(`GRANT USAGE ON SCHEMA ${qi(schema)} TO ${role}`)
    const privileges = demo ? 'SELECT' : 'SELECT, INSERT, UPDATE, DELETE'
    await c.query(`GRANT ${privileges} ON ALL TABLES IN SCHEMA ${qi(schema)} TO ${role}`)
    await c.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA ${qi(schema)} GRANT ${privileges} ON TABLES TO ${role}`,
    )
    await c.query(`GRANT ${role} TO ${qi(SQL_ROLE)}`)
    await c.query(`ALTER ROLE ${role} SET statement_timeout='5s'`)
    await c.query(`ALTER ROLE ${role} SET work_mem='16MB'`)
    await c.query(
      `INSERT INTO public.lb_template_instances(project_id,template_id,version,locale,user_id,request_id,demo) VALUES($1,$6,$7,$2,$3,$4,$5)`,
      [id, locale, userId, requestId, demo, template.id, template.version],
    )
    if (!demo) {
      await c.query(
        `INSERT INTO public.lb_apps(id,project_id,name,source_version,runtime_state) VALUES($1,$1,$2,1,'cold')`,
        [id, name],
      )
      const files: import('../apps/apps.service').AppFile[] = template.files.map((f) =>
        f.path === 'src/template-config.ts'
          ? {
              ...f,
              content: `export const defaultLocale = '${locale}' as const\n`,
            }
          : f,
      )
      await c.query('INSERT INTO public.lb_app_files(app_id,files) VALUES($1,$2)', [
        id,
        JSON.stringify(files),
      ])
      await c.query(`INSERT INTO public.lb_storage_files(key,user_id,project_id,category,bytes) VALUES($1,$2,$3,'source',$4)`,['source:'+id,userId,id,files.reduce((n,f)=>n+Buffer.byteLength(f.content, f.encoding === 'base64' ? 'base64' : 'utf8'),0)])
    }
  }
}
