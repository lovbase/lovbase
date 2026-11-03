import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { SchemaService } from '../src/database/schema.service'
import { ConfigService } from '../src/config/config.service'
import { RolesService } from '../src/modules/roles/roles.service'
import { ProjectsService } from '../src/modules/projects/projects.service'
import { LimitsService } from '../src/modules/limits/limits.service'
import { AppsService } from '../src/modules/apps/apps.service'

const url = process.env.TEMPLATE_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
suite('community template covers', () => {
  const pool = new Pool({ connectionString: url })
  const schema = new SchemaService(pool)
  const cfg = ConfigService.of({ DATABASE_URL: url, SQL_ROLE_PASSWORD: 'templates-sql-test' })
  const roles = new RolesService(pool, cfg)
  const limits = new LimitsService(pool, cfg, schema)
  const projects = new ProjectsService(pool, schema, roles, limits)
  const apps = new AppsService(pool, schema, limits)
  const userId = `cover-test-${randomUUID()}`
  const ids: string[] = []
  async function published(cover: string | null) {
    const project = await projects.create(userId)
    ids.push(project.id)
    const app = await apps.create(project.id, 'Cover test')
    const id = 't' + randomUUID().slice(0, 11)
    await pool.query(
      `INSERT INTO public.lb_community_templates(id,owner_id,project_id,app_id,name,ir,files,cover_url,status)
       VALUES($1,$2,$3,$4,'Cover test','{}','[]',$5,'approved')`,
      [id, userId, project.id, app.id, cover],
    )
    const coverOf = async () =>
      (await pool.query('SELECT cover_url FROM public.lb_community_templates WHERE id=$1', [id])).rows[0].cover_url
    return { project, app, coverOf }
  }
  beforeAll(async () => {
    await schema.ready()
    await pool.query(
      'INSERT INTO public."user"(id,name,email,plan,"createdAt","updatedAt") VALUES($1,$1,$2,\'pro\',now(),now())',
      [userId, `${userId}@example.invalid`],
    )
  }, 30000)
  afterAll(async () => {
    await pool.query('DELETE FROM public.lb_community_templates WHERE owner_id=$1', [userId])
    for (const id of ids) await projects.remove(id)
    await pool.query('DELETE FROM public."user" WHERE id=$1', [userId])
    await pool.end()
  })

  test('a template published before its app had a cover gets the cover once it is taken', async () => {
    const { project, app, coverOf } = await published(null)
    expect(await coverOf()).toBeNull()
    await apps.markCovered(app.id)
    expect(await coverOf()).toBe(`/api/files/public/thumb/${project.id}/${app.id}.png`)
  })

  test('a template that already has a cover keeps it', async () => {
    const { app, coverOf } = await published('/api/files/custom.png')
    await apps.markCovered(app.id)
    expect(await coverOf()).toBe('/api/files/custom.png')
  })

  test('startup backfills templates whose app was covered before this fix', async () => {
    const { project, app, coverOf } = await published(null)
    await pool.query('UPDATE public.lb_apps SET cover_at=now() WHERE id=$1', [app.id])
    // A fresh SchemaService runs the idempotent startup statements again.
    await new SchemaService(pool).ready()
    expect(await coverOf()).toBe(`/api/files/public/thumb/${project.id}/${app.id}.png`)
  })
})
