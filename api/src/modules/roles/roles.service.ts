import { Injectable, Logger } from '@nestjs/common'
import type pg from 'pg'
import { ConfigService } from '../../config/config.service'
import { InjectPool } from '../../database/pool.provider'

// ── Postgres roles ──
// ws_<id>       NOLOGIN group role: USAGE on its schema + DML on its tables. Nothing else.
// lovbase_sql   LOGIN executor used by the data API. Member of every ws_* role, owns nothing.
// Paid "direct connect" later = a LOGIN role created IN ROLE ws_<id> with its own password.

export const SQL_ROLE = 'lovbase_sql'
export const roleFor = (projectId: string) => `ws_${projectId}`
export const schemaFor = (projectId: string) => `p_${projectId}`

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`

@Injectable()
export class RolesService {
  private readonly log = new Logger('roles')
  private executorReady: Promise<void> | null = null

  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly cfg: ConfigService) {}

  ensureExecutorRole(): Promise<void> {
    this.executorReady ??= (async () => {
      const r = await this.pool.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [SQL_ROLE])
      // Keep the password in step with the configured secret. Creating it only when absent meant a
      // rotated SQL_ROLE_PASSWORD silently stopped matching, and every data-API query failed
      // authentication with nothing in the app to explain why.
      const password = literal(this.cfg.env.SQL_ROLE_PASSWORD)
      if (r.rows.length === 0)
        await this.pool.query(`CREATE ROLE ${ident(SQL_ROLE)} LOGIN NOINHERIT PASSWORD ${password}`)
      else
        await this.pool.query(`ALTER ROLE ${ident(SQL_ROLE)} LOGIN NOINHERIT PASSWORD ${password}`)
      // Never able to create objects anywhere, even if a schema is world-writable.
      await this.pool.query(`REVOKE CREATE ON SCHEMA public FROM ${ident(SQL_ROLE)}`)
    })()
    return this.executorReady
  }

  /**
   * Per-tenant resource caps. Managed Postgres often reserves some of these for superusers
   * (Neon rejects temp_file_limit), so each one is applied on its own and a permission error
   * is downgraded to a warning: losing one cap must not stop a project from being created.
   */
  private async applyCaps(role: string) {
    const caps: [string, string][] = [['work_mem', '16MB'], ['temp_file_limit', '256MB'], ['statement_timeout', '5s']]
    for (const [param, value] of caps) {
      try {
        await this.pool.query(`ALTER ROLE ${ident(role)} SET ${param} = ${literal(value)}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!/permission denied|must be superuser|unrecognized configuration/i.test(msg)) throw err
        this.log.warn(`role cap ${param} unavailable on this Postgres: ${msg}`)
      }
    }
  }

  /** Idempotent: safe to call on every request; one cheap catalog lookup when the role exists. */
  async ensureWorkspaceRole(projectId: string): Promise<string> {
    await this.ensureExecutorRole()
    const role = roleFor(projectId)
    const schema = schemaFor(projectId)
    const r = await this.pool.query(`SELECT rolconfig FROM pg_roles WHERE rolname = $1`, [role])
    if (r.rows.length > 0) {
      if (!r.rows[0].rolconfig) await this.applyCaps(role)   // created before per-role caps existed
      return role
    }
    await this.pool.query(`CREATE ROLE ${ident(role)} NOLOGIN NOINHERIT`)
    // A runaway query can't take the memory or disk of the whole cluster.
    await this.applyCaps(role)
    await this.pool.query(`GRANT USAGE ON SCHEMA ${ident(schema)} TO ${ident(role)}`)
    await this.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${ident(schema)} TO ${ident(role)}`)
    // Tables the builder creates later (as the platform user) inherit the grant.
    await this.pool.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA ${ident(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(role)}`)
    await this.pool.query(`GRANT ${ident(role)} TO ${ident(SQL_ROLE)}`)
    return role
  }

  async dropWorkspaceRole(projectId: string) {
    const role = roleFor(projectId)
    const schema = schemaFor(projectId)
    const r = await this.pool.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])
    if (r.rows.length === 0) return
    // Schema is already gone by the time this runs; default privileges must be dropped explicitly.
    await this.pool
      .query(`ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA ${ident(schema)} REVOKE ALL ON TABLES FROM ${ident(role)}`)
      .catch(() => {})
    await this.pool.query(`DROP ROLE ${ident(role)}`)
  }

  /** Demo workspaces: the role keeps SELECT only, so no code path can write, whatever the UI shows. */
  async setSchemaReadOnly(projectId: string) {
    const role = roleFor(projectId)
    const schema = schemaFor(projectId)
    await this.ensureWorkspaceRole(projectId)
    await this.pool.query(`REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${ident(schema)} FROM ${ident(role)}`)
    await this.pool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA ${ident(schema)} REVOKE INSERT, UPDATE, DELETE ON TABLES FROM ${ident(role)}`)
  }
}
