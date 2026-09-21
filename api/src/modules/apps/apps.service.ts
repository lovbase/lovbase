import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { randomId } from '../../common/ids'
import { NotFound, SlugTaken } from '../../common/errors'

/** A frontend built on a workspace. One workspace can have several, all sharing the same data. */
export type App = { id: string; project_id: string; name: string; created_at: string; slug: string | null; published_at: string | null }
export type AppFile = { path: string; content: string }

@Injectable()
export class AppsService {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService) {}

  async list(projectId: string): Promise<App[]> {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT * FROM public.lb_apps WHERE project_id = $1 ORDER BY created_at`, [projectId])
    return r.rows as App[]
  }

  async find(projectId: string, appId: string): Promise<App | null> {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT * FROM public.lb_apps WHERE id = $1 AND project_id = $2`, [appId, projectId])
    return (r.rows[0] as App) ?? null
  }

  async get(projectId: string, appId: string): Promise<App> {
    const a = await this.find(projectId, appId)
    if (!a) throw new NotFound('应用不存在')
    return a
  }

  async create(projectId: string, name: string): Promise<App> {
    const r = await this.pool.query(
      `INSERT INTO public.lb_apps (id, project_id, name) VALUES ($1, $2, $3) RETURNING *`, ['b' + randomId(11), projectId, name])
    return r.rows[0] as App
  }

  async rename(projectId: string, appId: string, name: string) {
    await this.pool.query(`UPDATE public.lb_apps SET name = $3, updated_at = now() WHERE id = $1 AND project_id = $2`,
      [appId, projectId, name])
  }

  async remove(projectId: string, appId: string) {
    await this.pool.query(`DELETE FROM public.lb_app_files WHERE app_id = $1`, [appId])
    await this.pool.query(`DELETE FROM public.lb_apps WHERE id = $1 AND project_id = $2`, [appId, projectId])
  }

  // ── Generated source, mirrored out of the sandbox ──
  // A container loses its filesystem when it is evicted, so the source is snapshotted here after
  // every change and written back when a fresh container comes up.

  async saveSnapshot(appId: string, files: AppFile[]) {
    if (files.length === 0) return
    await this.pool.query(
      `INSERT INTO public.lb_app_files (app_id, files, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (app_id) DO UPDATE SET files = EXCLUDED.files, updated_at = now()`,
      [appId, JSON.stringify(files)])
  }

  async loadSnapshot(appId: string): Promise<AppFile[] | null> {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT files FROM public.lb_app_files WHERE app_id = $1`, [appId])
    return (r.rows[0]?.files as AppFile[]) ?? null
  }

  // ── Publishing ──

  /**
   * The published subdomain. It defaults to the app id, which is already unique, because names
   * collide constantly ("crm", "todo") and a failed claim at publish time is a bad moment to
   * discover that. A chosen name is a paid feature and goes through `setSlug`.
   */
  async claimSlug(appId: string): Promise<string> {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT slug FROM public.lb_apps WHERE id = $1`, [appId])
    if (r.rows[0]?.slug) return r.rows[0].slug as string
    await this.pool.query(`UPDATE public.lb_apps SET slug = $1 WHERE id = $1`, [appId])
    return appId
  }

  /** Move an app to a chosen subdomain. Rejects anything already claimed. */
  async setSlug(appId: string, slug: string): Promise<string> {
    await this.schema.ready()
    const taken = await this.pool.query(`SELECT 1 FROM public.lb_apps WHERE slug = $1 AND id <> $2`, [slug, appId])
    if (taken.rowCount) throw new SlugTaken()
    await this.pool.query(`UPDATE public.lb_apps SET slug = $2 WHERE id = $1`, [appId, slug])
    return slug
  }

  async clearPublish(appId: string) {
    await this.pool.query(`UPDATE public.lb_apps SET slug = NULL, published_at = NULL WHERE id = $1`, [appId])
  }

  async markPublished(appId: string) {
    await this.pool.query(`UPDATE public.lb_apps SET published_at = now() WHERE id = $1`, [appId])
  }

  /**
   * A cover was taken. Recorded rather than inferred from `published_at`: an app published before
   * covers existed has no picture, and a card that assumes otherwise asks for one and gets a 404.
   * The timestamp doubles as the version in the URL, so a replaced cover is not served from cache.
   */
  async markCovered(appId: string) {
    await this.pool.query(`UPDATE public.lb_apps SET cover_at = now() WHERE id = $1`, [appId])
  }
}
