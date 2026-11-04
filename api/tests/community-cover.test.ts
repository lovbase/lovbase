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
import { CommunityTemplatesService } from '../src/modules/templates/community.service'
import type { StorageService } from '../src/modules/storage/storage.service'

/** A 1×1 PNG: the smallest thing that passes the signature check. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** Object storage as a map, so the test can see what was written and what was swept. */
function memoryStorage() {
  const objects = new Map<string, Uint8Array>()
  const storage = {
    enabled: true,
    objects,
    async put(key: string, bytes: Uint8Array) { objects.set(key, bytes) },
    async delete(key: string) { objects.delete(key) },
    async list(prefix: string) { return [...objects.keys()].filter((k) => k.startsWith(prefix)) },
    async deletePrefix(prefix: string) { for (const k of objects.keys()) if (k.startsWith(prefix)) objects.delete(k); return 0 },
  }
  return storage as typeof storage & StorageService
}

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
  const storage = memoryStorage()
  // `apply` is only used when a template is turned into a project, which these tests never do.
  const community = new CommunityTemplatesService(pool, schema, projects, null as never, apps, storage)
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
      'INSERT INTO public."user"(id,name,email,"emailVerified",plan,"createdAt","updatedAt") VALUES($1,$1,$2,false,\'pro\',now(),now())',
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

  async function template(cover: string | null) {
    const t = await published(cover)
    const id = (await pool.query('SELECT id FROM public.lb_community_templates WHERE app_id=$1', [t.app.id])).rows[0].id as string
    const row = async () => (await pool.query('SELECT cover_url, status, featured FROM public.lb_community_templates WHERE id=$1', [id])).rows[0]
    return { ...t, id, row }
  }

  test("an owner's uploaded cover replaces the screenshot and goes back to review", async () => {
    const { id, row } = await template('/api/files/public/thumb/p/black.png')
    await pool.query('UPDATE public.lb_community_templates SET featured=true WHERE id=$1', [id])
    const first = await community.setCover({ id: userId, isAdmin: false }, id, PNG)
    expect(first.coverUrl).toStartWith(`/api/files/public/thumb/${id}/cover-`)
    expect(await row()).toMatchObject({ cover_url: first.coverUrl, status: 'pending', featured: false })
    // A second upload gets a new URL — covers are served immutable — and the first is swept.
    const second = await community.setCover({ id: userId, isAdmin: false }, id, PNG)
    expect(second.coverUrl).not.toBe(first.coverUrl)
    expect(await storage.list(`public/thumb/${id}/`)).toEqual([second.coverUrl.replace('/api/files/', '')])
  })

  test("an admin's upload keeps the template live", async () => {
    const { id, row } = await template(null)
    await community.setCover({ id: 'someone-else', isAdmin: true }, id, PNG)
    expect((await row()).status).toBe('approved')
  })

  test('nobody else can change the cover, and only real images are accepted', async () => {
    const { id } = await template(null)
    await expect(community.setCover({ id: 'someone-else', isAdmin: false }, id, PNG)).rejects.toThrow('Not your template')
    await expect(community.setCover({ id: userId, isAdmin: false }, id, 'data:image/svg+xml;base64,PHN2Zz4=')).rejects.toThrow()
  })

  test('resubmitting the app keeps an uploaded cover instead of the screenshot', async () => {
    const { project, app, id, row } = await template(null)
    await apps.saveSnapshot(app.id, [{ path: 'index.html', content: '<p>hi</p>' }] as never)
    await apps.markPublished(app.id)
    await apps.markCovered(app.id)
    const { coverUrl } = await community.setCover({ id: userId, isAdmin: false }, id, PNG)
    await community.publish(userId, { projectId: project.id, appId: app.id, name: 'Cover test v2' })
    expect((await row()).cover_url).toBe(coverUrl)
  })
})
