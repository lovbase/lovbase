import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { z } from 'zod'
import { diffIR } from '@lovbase/core/diff'
import { emptyIR, type IR } from '@lovbase/core/ir'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { randomId } from '../../common/ids'
import { DomainError, Forbidden, NotFound } from '../../common/errors'
import { ProjectsService } from '../projects/projects.service'
import { ApplyService } from '../modeling/apply.service'
import { AppsService, type AppFile } from '../apps/apps.service'
import { FILES_PREFIX } from '../storage/attachments.service'
import { thumbKey } from '../storage/keys'

export type TemplateStatus = 'pending' | 'approved' | 'rejected'

export type TemplateCategory = { id: string; nameZh: string; nameEn: string; sort: number }

/** A community template as lists show it: everything but the snapshot itself. */
export type CommunityTemplate = {
  id: string
  name: string
  description: string
  categoryId: string | null
  tags: string[]
  coverUrl: string | null
  status: TemplateStatus
  featured: boolean
  reviewNote: string | null
  uses: number
  author: string
  ownerId: string
  projectId: string | null
  appId: string
  tables: number
  createdAt: string
  updatedAt: string
}

export const publishTemplateInput = z.object({
  projectId: z.string().min(1).max(64),
  appId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(280).default(''),
  categoryId: z.string().max(40).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(20)).max(5).default([]),
})
export type PublishTemplateInput = z.input<typeof publishTemplateInput>

export const categoryInput = z.object({
  id: z.string().trim().regex(/^[a-z0-9-]{2,40}$/, 'Lowercase letters, digits and hyphens'),
  nameZh: z.string().trim().min(1).max(30),
  nameEn: z.string().trim().min(1).max(40),
  sort: z.number().int().min(0).max(10_000).default(0),
})

const LIST = `SELECT t.id, t.name, t.description, t.category_id, t.tags, t.cover_url, t.status, t.featured,
    t.review_note, t.uses, t.owner_id, t.project_id, t.app_id, t.created_at, t.updated_at,
    jsonb_array_length(t.ir->'entities') AS tables,
    coalesce(nullif(u.name, ''), split_part(u.email, '@', 1), '') AS author
  FROM public.lb_community_templates t LEFT JOIN public."user" u ON u.id = t.owner_id`

const row = (r: Record<string, any>): CommunityTemplate => ({
  id: r.id, name: r.name, description: r.description, categoryId: r.category_id, tags: r.tags ?? [],
  coverUrl: r.cover_url, status: r.status, featured: r.featured, reviewNote: r.review_note,
  uses: Number(r.uses), author: r.author, ownerId: r.owner_id, projectId: r.project_id, appId: r.app_id,
  tables: Number(r.tables ?? 0), createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
})

/**
 * Templates people publish from their own apps, and the review that stands between publishing
 * and the gallery. Publishing takes a snapshot rather than pointing at the project, so the owner
 * can keep changing their app without changing what other people get, and a deleted project does
 * not take the template with it.
 */
@Injectable()
export class CommunityTemplatesService {
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly schema: SchemaService,
    private readonly projects: ProjectsService,
    private readonly apply: ApplyService,
    private readonly apps: AppsService,
  ) {}

  async categories(): Promise<TemplateCategory[]> {
    await this.schema.ready()
    const r = await this.pool.query('SELECT * FROM public.lb_template_categories ORDER BY sort, name_en')
    return r.rows.map((c) => ({ id: c.id, nameZh: c.name_zh, nameEn: c.name_en, sort: c.sort }))
  }

  /** The gallery: approved only, featured first, then what people actually use. */
  async gallery(): Promise<CommunityTemplate[]> {
    await this.schema.ready()
    const r = await this.pool.query(`${LIST} WHERE t.status = 'approved' ORDER BY t.featured DESC, t.uses DESC, t.created_at DESC LIMIT 200`)
    return r.rows.map(row)
  }

  async mine(userId: string): Promise<CommunityTemplate[]> {
    await this.schema.ready()
    const r = await this.pool.query(`${LIST} WHERE t.owner_id = $1 ORDER BY t.updated_at DESC`, [userId])
    return r.rows.map(row)
  }

  /** What the owner has already submitted for this app, so the publish form can show it. */
  async forApp(userId: string, appId: string): Promise<CommunityTemplate | null> {
    await this.schema.ready()
    const r = await this.pool.query(`${LIST} WHERE t.app_id = $1 AND t.owner_id = $2`, [appId, userId])
    return r.rows[0] ? row(r.rows[0]) : null
  }

  /** One template for its preview page. Unapproved ones are visible to their owner and admins only. */
  async get(id: string, viewer?: { id: string; isAdmin: boolean }) {
    await this.schema.ready()
    const r = await this.pool.query(`${LIST} WHERE t.id = $1`, [id])
    const t = r.rows[0] ? row(r.rows[0]) : null
    if (!t || (t.status !== 'approved' && t.ownerId !== viewer?.id && !viewer?.isAdmin)) throw new NotFound('Template not found')
    const app = t.projectId ? await this.pool.query('SELECT slug, published_at FROM public.lb_apps WHERE id = $1', [t.appId]) : null
    const live = app?.rows[0]?.published_at && app.rows[0].slug ? (app.rows[0].slug as string) : null
    return { ...t, liveSlug: live }
  }

  /**
   * Publish an app as a template, or replace the snapshot of one already published. Either way it
   * goes (back) to review: an approval was for the snapshot a reviewer looked at, not for whatever
   * the app becomes later.
   */
  async publish(userId: string, raw: PublishTemplateInput) {
    const input = publishTemplateInput.parse(raw)
    await this.schema.ready()
    const project = await this.projects.find(input.projectId)
    if (!project || project.owner_id !== userId) throw new Forbidden('Not your project')
    const app = await this.apps.find(project.id, input.appId)
    if (!app) throw new NotFound('App not found')
    if (!app.published_at) throw new DomainError('Publish the app first: the template is made from the published version')
    const files = await this.apps.loadSnapshot(app.id)
    if (!files?.length) throw new DomainError('This app has no source to share yet')
    if (input.categoryId && !(await this.categories()).some((c) => c.id === input.categoryId)) throw new DomainError('Unknown category')
    const covered = await this.pool.query('SELECT cover_at FROM public.lb_apps WHERE id = $1', [app.id])
    const cover = covered.rows[0]?.cover_at ? FILES_PREFIX + thumbKey(project.id, app.id) : null
    const tags = [...new Set(input.tags.map((t) => t.toLowerCase()))]
    const ir: IR = { ...project.ir, appName: input.name }
    const r = await this.pool.query(
      `INSERT INTO public.lb_community_templates(id, owner_id, project_id, app_id, name, description, category_id, tags, ir, files, cover_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (app_id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
         category_id = EXCLUDED.category_id, tags = EXCLUDED.tags, ir = EXCLUDED.ir, files = EXCLUDED.files,
         cover_url = EXCLUDED.cover_url, status = 'pending', featured = false, review_note = NULL,
         reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
       WHERE lb_community_templates.owner_id = EXCLUDED.owner_id
       RETURNING id`,
      ['t' + randomId(11), userId, project.id, app.id, input.name, input.description, input.categoryId, tags, JSON.stringify(ir), JSON.stringify(files), cover])
    if (!r.rows[0]) throw new Forbidden('Not your template')
    return { id: r.rows[0].id as string }
  }

  async withdraw(userId: string, id: string) {
    await this.schema.ready()
    const r = await this.pool.query('DELETE FROM public.lb_community_templates WHERE id = $1 AND owner_id = $2', [id, userId])
    if (!r.rowCount) throw new NotFound('Template not found')
  }

  /**
   * A new project from a template: its schema applied through the same diff path the agent uses,
   * then its source. No rows — templates never carry any. Retrying with the same request id
   * returns the project the first attempt made.
   */
  async use(userId: string, id: string, name: string, requestId: string) {
    await this.schema.ready()
    const prior = await this.pool.query('SELECT project_id FROM public.lb_community_template_uses WHERE user_id = $1 AND request_id = $2', [userId, requestId])
    if (prior.rows[0]) return { projectId: prior.rows[0].project_id as string }
    const t = await this.pool.query(`SELECT ir, files, status FROM public.lb_community_templates WHERE id = $1`, [id])
    if (!t.rows[0] || t.rows[0].status !== 'approved') throw new NotFound('Template not found')
    const ir: IR = { ...(t.rows[0].ir as IR), appName: name }
    const project = await this.projects.create(userId)
    await this.apply.apply(project.id, ir, diffIR(emptyIR(), ir), 'Created from a template')
    await this.projects.setName(project.id, name)
    await this.apps.saveSnapshot(project.id, t.rows[0].files as AppFile[])
    await this.pool.query(
      `WITH used AS (INSERT INTO public.lb_community_template_uses(user_id, request_id, template_id, project_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1)
       UPDATE public.lb_community_templates SET uses = uses + 1 WHERE id = $3 AND EXISTS (SELECT 1 FROM used)`,
      [userId, requestId, id, project.id])
    return { projectId: project.id }
  }

  // ── Admin ──

  async review(status?: TemplateStatus): Promise<CommunityTemplate[]> {
    await this.schema.ready()
    const r = await this.pool.query(
      `${LIST} ${status ? 'WHERE t.status = $1' : ''} ORDER BY (t.status = 'pending') DESC, t.updated_at DESC LIMIT 300`,
      status ? [status] : [])
    return r.rows.map(row)
  }

  async decide(id: string, reviewer: string, patch: { status?: TemplateStatus; featured?: boolean; note?: string | null; categoryId?: string | null; tags?: string[] }) {
    await this.schema.ready()
    const sets: string[] = []
    const args: unknown[] = [id]
    const set = (sql: string, v: unknown) => { args.push(v); sets.push(`${sql} = $${args.length}`) }
    if (patch.status) {
      set('status', patch.status)
      set('reviewed_by', reviewer)
      sets.push('reviewed_at = now()')
      // Only an approved template can be featured; taking approval away takes that too.
      if (patch.status !== 'approved') sets.push('featured = false')
    }
    if (patch.featured !== undefined) set('featured', patch.featured)
    if (patch.note !== undefined) set('review_note', patch.note || null)
    if (patch.categoryId !== undefined) set('category_id', patch.categoryId)
    if (patch.tags) set('tags', [...new Set(patch.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 5))
    if (!sets.length) return
    const r = await this.pool.query(`UPDATE public.lb_community_templates SET ${sets.join(', ')} WHERE id = $1
      ${patch.featured ? "AND status = 'approved'" : ''}`, args)
    if (!r.rowCount) throw new DomainError(patch.featured ? 'Approve the template before featuring it' : 'Template not found')
  }

  async saveCategory(raw: z.input<typeof categoryInput>) {
    const c = categoryInput.parse(raw)
    await this.schema.ready()
    await this.pool.query(
      `INSERT INTO public.lb_template_categories(id, name_zh, name_en, sort) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name_zh = EXCLUDED.name_zh, name_en = EXCLUDED.name_en, sort = EXCLUDED.sort`,
      [c.id, c.nameZh, c.nameEn, c.sort])
  }

  async deleteCategory(id: string) {
    await this.schema.ready()
    await this.pool.query('DELETE FROM public.lb_template_categories WHERE id = $1', [id])
  }
}
