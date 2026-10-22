import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { spawn } from 'node:child_process'
import { PassThrough, Readable } from 'node:stream'
import { once } from 'node:events'
import { ZipArchive } from 'archiver'
import { InjectPool } from '../../database/pool.provider'
import { ConfigService } from '../../config/config.service'
import { LimitsService } from '../limits/limits.service'
import { Forbidden } from '../../common/errors'
import type { ProjectCtx } from '../auth/access.service'

export function exportablePath(path: string) {
  return (
    !!path &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path
      .split('/')
      .some(
        (s) =>
          s === '..' ||
          s === '.' ||
          /^(node_modules|dist|build|coverage|\.cache|\.next|\.git|\.pi|\.ssh|\.aws|\.npmrc|\.netrc|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|service[-_]?account(?:\.[^/]*)?)$/.test(
            s,
          ) ||
          (/^\.env(?:\.|$)/.test(s) && s !== '.env.example') ||
          /\.(pem|key)$/i.test(s),
      )
  )
}
@Injectable()
export class ExportsService {
  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly cfg: ConfigService,
    private readonly limits: LimitsService,
  ) {}
  async assert(ctx: ProjectCtx) {
    if (!(await this.limits.plan(ctx.user.id)).exports) throw new Forbidden('Pro is required for complete exports')
  }
  async sql(ctx: ProjectCtx): Promise<Readable> {
    await this.assert(ctx)
    const url = new URL(this.cfg.env.DATABASE_URL)
    const child = spawn(
      this.cfg.env.PG_DUMP_PATH,
      ['--format=plain', '--strict-names', '--schema=p_' + ctx.project.id, '--no-owner', '--no-acl', '--encoding=UTF8'],
      {
        env: {
          ...process.env,
          PGHOST: url.hostname,
          PGPORT: url.port || '5432',
          PGUSER: decodeURIComponent(url.username),
          PGPASSWORD: decodeURIComponent(url.password),
          PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
          ...(url.searchParams.has('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode')! } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const out = new PassThrough()
    child.stderr.resume() // Never include connection credentials in client errors or logs.
    child.once('error', () => out.destroy(new Error('SQL export unavailable: check PostgreSQL client configuration')))
    child.stdout.pipe(out, { end: false })
    child.once('close', (code) => {
      if (code === 0) out.end()
      else out.destroy(new Error('SQL export failed'))
    })
    out.once('close', () => {
      if (child.exitCode === null) child.kill('SIGTERM')
    })
    return out
  }
  async source(ctx: ProjectCtx): Promise<Readable> {
    await this.assert(ctx)
    const zip = new ZipArchive({ zlib: { level: 6 } }),
      out = new PassThrough()
    zip.on('error', (e) => out.destroy(e))
    zip.pipe(out)
    out.once('close', () => {
      zip.abort()
    })
    void (async () => {
      const db = await this.pool.connect().catch(() => {
        out.destroy(new Error('Source export unavailable'))
        return null
      })
      if (!db) return
      try {
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await db.query(`DECLARE source_files NO SCROLL CURSOR FOR
          SELECT a.id, f.value AS file FROM public.lb_apps a JOIN public.lb_app_files s ON s.app_id=a.id
          CROSS JOIN LATERAL jsonb_array_elements(s.files) f(value)
          WHERE a.project_id=${"'" + ctx.project.id.replace(/'/g, "''") + "'"} ORDER BY a.id,f.value->>'path'`)
        while (!out.destroyed) {
          const r = await db.query('FETCH FORWARD 1 FROM source_files')
          if (!r.rowCount) break
          const { id, file } = r.rows[0]
          if (!exportablePath(file.path)) continue
          const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8')
          const entered = once(zip, 'entry')
          zip.append(
            Readable.from(
              (function* () {
                for (let i = 0; i < bytes.length; i += 65536) yield bytes.subarray(i, i + 65536)
              })(),
            ),
            { name: `apps/${id}/${file.path}` },
          )
          let cancel!: () => void
          const canceled = new Promise<never>((_, reject) => {
            cancel = () => reject(new Error('Export canceled'))
            out.once('close', cancel)
          })
          try {
            await Promise.race([entered, canceled])
          } finally {
            out.off('close', cancel)
          }
        }
        await db.query('CLOSE source_files')
        await db.query('COMMIT')
        if (!out.destroyed) await zip.finalize()
      } catch (e) {
        await db.query('ROLLBACK').catch(() => {})
        out.destroy(e instanceof Error ? e : new Error('Source export failed'))
      } finally {
        db.release()
      }
    })()
    return out
  }
}
