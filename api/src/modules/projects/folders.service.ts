import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { randomId } from '../../common/ids'
import { NotFound } from '../../common/errors'

export type Folder = { id: string; owner_id: string; name: string; created_at: string }

/** One level of folders per owner; a project sits in at most one. Ownership is in every WHERE clause. */
@Injectable()
export class FoldersService {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService) {}

  async list(ownerId: string): Promise<Folder[]> {
    await this.schema.ready()
    const r = await this.pool.query(`SELECT * FROM public.lb_folders WHERE owner_id = $1 ORDER BY name`, [ownerId])
    return r.rows as Folder[]
  }

  async create(ownerId: string, name: string): Promise<Folder> {
    await this.schema.ready()
    const r = await this.pool.query(
      `INSERT INTO public.lb_folders (id, owner_id, name) VALUES ($1, $2, $3) RETURNING *`, ['d' + randomId(11), ownerId, name])
    return r.rows[0] as Folder
  }

  async rename(ownerId: string, id: string, name: string) {
    await this.pool.query(`UPDATE public.lb_folders SET name = $3 WHERE id = $1 AND owner_id = $2`, [id, ownerId, name])
  }

  async remove(ownerId: string, id: string) {
    await this.pool.query(`DELETE FROM public.lb_folders WHERE id = $1 AND owner_id = $2`, [id, ownerId])
  }

  async moveProject(ownerId: string, projectId: string, folderId: string | null) {
    if (folderId) {
      const f = await this.pool.query(`SELECT 1 FROM public.lb_folders WHERE id = $1 AND owner_id = $2`, [folderId, ownerId])
      if (f.rows.length === 0) throw new NotFound('Folder not found')
    }
    await this.pool.query(`UPDATE public.lb_projects SET folder_id = $3 WHERE id = $1 AND owner_id = $2`, [projectId, ownerId, folderId])
  }

  async starProject(ownerId: string, projectId: string, starred: boolean) {
    await this.pool.query(`UPDATE public.lb_projects SET starred = $3 WHERE id = $1 AND owner_id = $2`, [projectId, ownerId, starred])
  }
}
