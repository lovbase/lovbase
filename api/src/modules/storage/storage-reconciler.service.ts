import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { createHash } from 'node:crypto'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import { ConfigService } from '../../config/config.service'
import { StorageService } from './storage.service'
import { LimitsService, type StorageScope } from '../limits/limits.service'
import { parseKey, chatAttachmentKey } from './keys'

/** Idempotent inventory; only a successful complete listing may remove old manifest entries. */
@Injectable()
export class StorageReconciler {
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly schema: SchemaService,
    private readonly cfg: ConfigService,
    private readonly storage: StorageService,
    private readonly limits: LimitsService,
  ) {}
  async reconcile() {
    await this.schema.ready()
    const started = new Date(),
      entries = new Map<string, StorageScope & { bytes: number }>()
    const projects = (await this.pool.query('SELECT id,owner_id FROM public.lb_projects WHERE owner_id IS NOT NULL'))
      .rows
    const validUsers = new Set((await this.pool.query('SELECT id FROM public."user"')).rows.map((r) => r.id))
    const owners = new Map<string, string>(projects.map((p) => [p.id, p.owner_id]))
    // Read the transcript one project at a time, rather than loading every inline file at once.
    for (const p of projects) {
      const chat =
        (await this.pool.query('SELECT messages FROM public.lb_chat WHERE project_id=$1', [p.id])).rows[0]?.messages ??
        []
      for (const message of chat)
        for (const part of message.parts ?? []) {
          if (part.type !== 'file' || typeof part.url !== 'string' || !part.url.startsWith('data:')) continue
          const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(part.url)
          if (!m) continue
          let bytes: Buffer
          try {
            bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]))
          } catch {
            continue
          }
          const key =
            'inline:' + chatAttachmentKey(p.id, createHash('sha256').update(bytes).digest('hex'), part.filename)
          entries.set(key, { key, userId: p.owner_id, projectId: p.id, category: 'attachments', bytes: bytes.length })
        }
    }
    if (this.storage.enabled)
      for (const file of await this.storage.listObjects('')) {
        const parsed = parseKey(file.key)
        if (!parsed) continue
        const userId = parsed.kind === 'avatar' ? parsed.owner : owners.get(parsed.owner)
        if (!userId || !validUsers.has(userId)) continue
        entries.set(file.key, {
          key: file.key,
          userId,
          projectId: parsed.kind === 'avatar' ? undefined : parsed.owner,
          category: parsed.kind === 'chat' ? 'attachments' : parsed.kind,
          bytes: file.size,
        })
      }
    const apps = (
      await this.pool.query(
        'SELECT a.id,a.project_id,a.slug FROM public.lb_apps a JOIN public.lb_projects p ON p.id=a.project_id WHERE p.owner_id IS NOT NULL',
      )
    ).rows
    for (const app of apps) {
      const source = await this.pool.query(
        `SELECT coalesce(sum(CASE WHEN f.value->>'encoding'='base64'
        THEN octet_length(decode(f.value->>'content','base64')) ELSE octet_length(f.value->>'content') END),0)::bigint bytes
        FROM public.lb_app_files s CROSS JOIN LATERAL jsonb_array_elements(s.files) f(value) WHERE s.app_id=$1`,
        [app.id],
      )
      const key = 'source:' + app.id
      entries.set(key, {
        key,
        userId: owners.get(app.project_id)!,
        projectId: app.project_id,
        category: 'source',
        bytes: Number(source.rows[0].bytes),
      })
    }
    if (this.cfg.snapshotsConfigured) {
      const objects = await this.storage.listObjects('', {
        bucket: this.cfg.env.SANDBOX_BUCKET,
        endpoint: this.cfg.sandboxEndpoint,
      })
      for (const app of apps)
        for (const category of ['build', 'published'] as const) {
          const prefix = category === 'build' ? `snap/${app.id}/` : app.slug ? `${app.slug}/` : null
          const bytes = prefix ? objects.filter((o) => o.key.startsWith(prefix)).reduce((n, o) => n + o.size, 0) : 0
          const key = `static:${app.id}:${category}`
          entries.set(key, { key, userId: owners.get(app.project_id)!, projectId: app.project_id, category, bytes })
        }
    }
    const groups = new Map<string, (StorageScope & { bytes: number })[]>()
    for (const entry of entries.values()) {
      const group = groups.get(entry.userId) ?? []
      group.push(entry)
      groups.set(entry.userId, group)
    }
    // Include users with now-empty storage so successfully deleted objects release their usage.
    const accounts = await this.pool.query('SELECT DISTINCT user_id FROM public.lb_storage_files')
    for (const userId of [...projects.map((p) => p.owner_id), ...accounts.rows.map((r) => r.user_id)])
      if (!groups.has(userId)) groups.set(userId, [])
    let incomplete = false
    for (const [userId, files] of groups)
      await this.limits.transaction(userId, async (db) => {
        // Storage can contain orphans from deleted accounts/projects. Lock live ownership while
        // applying the inventory so a concurrent deletion cannot turn calibration into a FK error.
        const account = await db.query('SELECT id FROM public."user" WHERE id=$1 FOR KEY SHARE', [userId])
        if (!account.rowCount) return
        const live = await db.query('SELECT id FROM public.lb_projects WHERE owner_id=$1 FOR KEY SHARE', [userId])
        const projectIds = new Set(live.rows.map((row) => row.id))
        const currentFiles = files.filter((file) => !file.projectId || projectIds.has(file.projectId))
        const reservations = await db.query(
          'SELECT 1 FROM public.lb_storage_reservations WHERE user_id=$1 AND expires_at>now() LIMIT 1',
          [userId],
        )
        if (reservations.rowCount) { incomplete = true; return }
        for (const f of currentFiles)
          await db.query(
            `INSERT INTO public.lb_storage_files(key,user_id,project_id,category,bytes,updated_at) VALUES($1,$2,$3,$4,$5,now())
        ON CONFLICT(key) DO UPDATE SET bytes=EXCLUDED.bytes,updated_at=now() WHERE lb_storage_files.updated_at<=$6`,
            [f.key, userId, f.projectId ?? null, f.category, f.bytes, started],
          )
        // Inline files live in transcripts, independently of bucket availability. A cleared
        // transcript must release those bytes even on installations without object storage.
        await db.query(
          `DELETE FROM public.lb_storage_files WHERE user_id=$1 AND updated_at<$2
          AND key LIKE 'inline:%' AND NOT(key=ANY($3::text[]))`,
          [userId, started, currentFiles.map((f) => f.key)],
        )
        if (this.storage.enabled)
          await db.query(
            `DELETE FROM public.lb_storage_files WHERE user_id=$1 AND updated_at<$2
        AND category IN ('attachments','avatar','thumb') AND NOT(key=ANY($3::text[]))`,
            [userId, started, currentFiles.map((f) => f.key)],
          )
      }, true)
    if (incomplete) throw new Error('Storage inventory deferred while uploads are active')
    await this.pool.query('UPDATE public.lb_billing_control SET storage_ready=true WHERE id=1')
  }
}
