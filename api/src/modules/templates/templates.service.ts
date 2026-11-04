import { effectivePlan } from '@lovbase/core/billing'
import { LimitsService } from '../limits/limits.service'
import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { z } from 'zod'
import { planOf } from '@lovbase/core/plans'
import { templates, type TemplateId } from '@lovbase/core/templates'
import type { Cell, TemplateRows } from '@lovbase/core/template-data'
import { qi } from '@lovbase/core/ddl'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { RolesService, schemaFor, roleFor, SQL_ROLE } from '../roles/roles.service'
import { randomId } from '../../common/ids'
import { DomainError, NotFound, PlanLimit } from '../../common/errors'
import { templateDefinition } from './registry'
import { countTemplate } from './stats'

export const remixInput = z.object({
  templateId: z.enum(templates.map((t) => t.id) as [TemplateId, ...TemplateId[]]),
  version: z.literal(1),
  name: z.string().trim().min(1).max(80),
  locale: z.enum(['zh', 'en']),
  requestId: z.string().uuid(),
})
export type RemixInput = z.infer<typeof remixInput>
export const DEMO_PROJECT = 'templateinventoryv1'
const NUMERIC = 1700

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
      await c.query(countTemplate('installs'), [input.templateId])
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
      const prior = await c.query(
        'SELECT seed_revision FROM public.lb_template_instances WHERE project_id=$1 AND demo=true',
        [demoId],
      )
      // A demo seeded by an older revision of the sample data is rebuilt under the same id, so
      // links to it keep working. Copies users made from the old data are theirs and stay as they are.
      const stale = prior.rowCount ? prior.rows[0].seed_revision !== template.seedRevision : false
      if (stale) await this.teardown(c, demoId)
      if (!prior.rowCount || stale)
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

  /**
   * The rows of an SQL-backed template, the way its app sees them through the SQL API: as the
   * project's role, one consistent snapshot, numerics as numbers and timestamps as ISO strings.
   */
  async readTables(projectId: string, templateId: TemplateId) {
    const template = templateDefinition(templateId)
    if (!template.tables) throw new NotFound('Template version not found')
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const meta = await c.query(
        `SELECT p.read_only FROM public.lb_projects p JOIN public.lb_template_instances t ON t.project_id=p.id WHERE p.id=$1 AND t.template_id=$2`,
        [projectId, templateId],
      )
      if (!meta.rows[0]) throw new NotFound('template_project_not_found')
      await c.query(`SET LOCAL ROLE ${qi(roleFor(projectId))}`)
      await c.query(`SET LOCAL statement_timeout='5s'`)
      const data: TemplateRows = { readOnly: !!meta.rows[0].read_only }
      for (const table of template.tables) {
        const result = await c.query(`SELECT * FROM ${qi(schemaFor(projectId))}.${qi(table)} ORDER BY created_at, id LIMIT 1001`)
        if (result.rows.length > 1000) throw new DomainError('dataset_too_large')
        const numeric = new Set(result.fields.filter((f) => f.dataTypeID === NUMERIC).map((f) => f.name))
        data[table] = result.rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value === null ? null : numeric.has(key) ? Number(value) : value instanceof Date ? value.toISOString() : value,
            ]),
          ) as Record<string, Cell>,
        )
      }
      await c.query('COMMIT')
      return data
    } catch (error) {
      await c.query('ROLLBACK')
      throw error
    } finally {
      c.release()
    }
  }

  /** Removes a project's schema, rows and role inside the caller's transaction. */
  private async teardown(c: pg.PoolClient, id: string) {
    await c.query(`DROP SCHEMA IF EXISTS ${qi(schemaFor(id))} CASCADE`)
    await c.query('DELETE FROM public.lb_projects WHERE id=$1', [id])
    if ((await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [roleFor(id)])).rowCount) {
      await c.query(`DROP OWNED BY ${qi(roleFor(id))}`)
      await c.query(`DROP ROLE ${qi(roleFor(id))}`)
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
      `INSERT INTO public.lb_template_instances(project_id,template_id,version,locale,user_id,request_id,demo,seed_revision) VALUES($1,$6,$7,$2,$3,$4,$5,$8)`,
      [id, locale, userId, requestId, demo, template.id, template.version, template.seedRevision],
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
