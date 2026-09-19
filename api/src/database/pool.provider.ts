import { Inject, Logger, type OnApplicationShutdown, Provider } from '@nestjs/common'
import pg from 'pg'
import { ConfigService } from '../config/config.service'

// ── Two process-wide pools ──
// The API runs as one long-lived Node process next to Postgres, so a single shared pool per role
// is the whole story: no per-request pools. `max` stays modest because every workspace request
// also takes a connection from the executor pool.

export const PG_POOL = Symbol('PG_POOL')
/** Low-privilege executor role: only DML, only inside a workspace's own schema. */
export const PG_SQL_POOL = Symbol('PG_SQL_POOL')

export const InjectPool = () => Inject(PG_POOL)
export const InjectSqlPool = () => Inject(PG_SQL_POOL)

function make(name: string, connectionString: string, max: number) {
  const pool = new pg.Pool({ connectionString, max })
  pool.on('error', (err) => new Logger('pg').error(`${name} pool: ${err.message}`))
  return pool
}

export const poolProviders: Provider[] = [
  {
    provide: PG_POOL,
    inject: [ConfigService],
    useFactory: (cfg: ConfigService) => make('owner', cfg.env.DATABASE_URL, cfg.env.PG_POOL_MAX),
  },
  {
    provide: PG_SQL_POOL,
    inject: [ConfigService],
    useFactory: (cfg: ConfigService) => make('executor', cfg.sqlUrl, cfg.env.PG_SQL_POOL_MAX),
  },
]

/** Closes both pools on shutdown so a redeploy does not leave connections behind. */
export class PoolCloser implements OnApplicationShutdown {
  constructor(@InjectPool() private readonly pool: pg.Pool, @InjectSqlPool() private readonly sqlPool: pg.Pool) {}
  async onApplicationShutdown() {
    await Promise.allSettled([this.pool.end(), this.sqlPool.end()])
  }
}
