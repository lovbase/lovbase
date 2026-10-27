import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { feedbackInput, feedbackStatus, FEEDBACK_IMAGE_BYTES, type FeedbackInput, type FeedbackStatus } from '@lovbase/core/feedback'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { DomainError, Forbidden, NotFound, TooManyRequests } from '../../common/errors'
import type { UserCtx } from '../auth/access.service'

export type FeedbackRow = {
  id: string; kind: FeedbackInput['kind']; message: string; page: string; status: FeedbackStatus
  project_id: string | null; project_name: string | null; email: string | null; name: string | null
  created_at: string; screenshots: { position: number; name: string }[]
}

/** Raster signatures are checked as well as the declared type; SVG/HTML never reach our origin. */
export function feedbackImage(dataUrl: string) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!match) throw new DomainError('Choose a PNG, JPEG or WebP screenshot')
  const bytes = Buffer.from(match[2], 'base64'), type = match[1]
  if (!bytes.length || bytes.length > FEEDBACK_IMAGE_BYTES || bytes.toString('base64') !== match[2])
    throw new DomainError('Each screenshot must be 2 MB or smaller')
  const valid = type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (!valid) throw new DomainError('The screenshot does not match its image type')
  return { bytes, type }
}

@Injectable()
export class FeedbackService {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService) {}

  async submit({ user }: UserCtx, raw: FeedbackInput) {
    const input = feedbackInput.parse(raw)
    const images = input.screenshots.map(image => ({ ...feedbackImage(image.dataUrl), name: image.name }))
    await this.schema.ready()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`feedback:${user.id}`])
      const existing = await client.query('SELECT user_id FROM public.lb_feedback WHERE id=$1', [input.id])
      if (existing.rows.length) {
        if (existing.rows[0].user_id !== user.id) throw new NotFound('Feedback not found')
        await client.query('COMMIT')
        return { id: input.id }
      }
      if (input.projectId) {
        const project = await client.query('SELECT 1 FROM public.lb_projects WHERE id=$1 AND owner_id=$2', [input.projectId, user.id])
        if (!project.rows.length) throw new NotFound('Project not found')
      }
      const recent = await client.query("SELECT count(*)::int AS n FROM public.lb_feedback WHERE user_id=$1 AND created_at>now()-interval '1 hour'", [user.id])
      if (recent.rows[0].n >= 10) throw new TooManyRequests('You have submitted 10 reports this hour. Please try again later.')
      await client.query(`INSERT INTO public.lb_feedback(id,user_id,project_id,kind,message,page) VALUES($1,$2,$3,$4,$5,$6)`,
        [input.id, user.id, input.projectId ?? null, input.kind, input.message, input.page])
      for (const [position, image] of images.entries()) await client.query(
        'INSERT INTO public.lb_feedback_images(feedback_id,position,name,content_type,bytes) VALUES($1,$2,$3,$4,$5)',
        [input.id, position, image.name, image.type, image.bytes])
      await client.query('COMMIT')
      return { id: input.id }
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }

  async list(ctx: UserCtx, status?: FeedbackStatus, offset = 0) {
    this.admin(ctx)
    await this.schema.ready()
    const result = await this.pool.query(`SELECT f.*, u.email, u.name, p.name AS project_name,
      coalesce((SELECT jsonb_agg(jsonb_build_object('position',i.position,'name',i.name) ORDER BY i.position)
        FROM public.lb_feedback_images i WHERE i.feedback_id=f.id),'[]'::jsonb) AS screenshots
      FROM public.lb_feedback f LEFT JOIN public."user" u ON u.id=f.user_id
      LEFT JOIN public.lb_projects p ON p.id=f.project_id
      WHERE ($1::text IS NULL OR f.status=$1) ORDER BY f.created_at DESC,f.id DESC LIMIT 21 OFFSET $2`, [status ?? null, offset])
    return { rows: result.rows.slice(0,20) as FeedbackRow[], hasMore: result.rows.length > 20 }
  }

  async setStatus(ctx: UserCtx, id: string, status: FeedbackStatus) {
    this.admin(ctx)
    await this.schema.ready()
    const result = await this.pool.query('UPDATE public.lb_feedback SET status=$2,updated_at=now() WHERE id=$1 RETURNING id', [id, feedbackStatus.parse(status)])
    if (!result.rows.length) throw new NotFound('Feedback not found')
  }

  async image({ user }: UserCtx, id: string, position: number) {
    await this.schema.ready()
    const result = await this.pool.query(`SELECT i.bytes,i.content_type FROM public.lb_feedback_images i
      JOIN public.lb_feedback f ON f.id=i.feedback_id WHERE f.id=$1 AND i.position=$2 AND (f.user_id=$3 OR $4::boolean)`, [id, position, user.id, user.isAdmin])
    if (!result.rows.length) throw new NotFound('Screenshot not found')
    return result.rows[0] as { bytes: Buffer; content_type: string }
  }

  private admin({ user }: UserCtx) { if (!user.isAdmin) throw new Forbidden('Admin access required') }
}
