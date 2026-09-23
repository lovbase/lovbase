import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'

/** Product analytics for generated apps: one row per event, visitor id is a daily-rotating hash. */
export type EventIn = { type: 'pageview' | 'leave'; path: string; referrer: string | null; duration_ms: number | null }

@Injectable()
export class AnalyticsService {
  constructor(@InjectPool() private readonly pool: pg.Pool, private readonly schema: SchemaService) {}

  async insert(projectId: string, visitor: string, country: string | null, device: string, events: EventIn[]) {
    if (events.length === 0) return
    const values: unknown[] = []
    const rows = events.map((e, i) => {
      values.push(projectId, e.type, e.path.slice(0, 200), e.referrer?.slice(0, 200) ?? null, country, device, visitor, e.duration_ms)
      const b = i * 8
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`
    })
    await this.pool.query(`INSERT INTO public.lb_events (project_id, type, path, referrer, country, device, visitor, duration_ms) VALUES ${rows.join(', ')}`, values)
  }

  /** Sessions = per-visitor runs of events with < 30 min gaps. Everything else derives from them. */
  async report(projectId: string, days: number) {
    await this.schema.ready()
    const args = [projectId, `${days} days`]
    const sessions = `
      WITH ev AS (
        SELECT *, lag(ts) OVER (PARTITION BY visitor ORDER BY ts) AS prev
        FROM public.lb_events WHERE project_id = $1 AND ts > now() - $2::interval
      ), marked AS (
        SELECT *, CASE WHEN prev IS NULL OR ts - prev > interval '30 min' THEN 1 ELSE 0 END AS new_s FROM ev
      ), s AS (
        SELECT *, sum(new_s) OVER (PARTITION BY visitor ORDER BY ts) AS sid FROM marked
      ), sess AS (
        SELECT visitor, sid,
               min(ts) AS started, max(ts) AS ended,
               count(*) FILTER (WHERE type = 'pageview') AS views,
               coalesce(sum(duration_ms) FILTER (WHERE type = 'leave'), 0) AS dur_ms,
               (array_agg(referrer ORDER BY ts))[1] AS referrer,
               (array_agg(country ORDER BY ts))[1] AS country,
               (array_agg(device ORDER BY ts))[1] AS device
        FROM s GROUP BY visitor, sid
      )`
    const [kpi, series, bySource, byPage, byDevice, byCountry, live] = await Promise.all([
      this.pool.query(`${sessions} SELECT count(DISTINCT visitor)::int AS visitors, coalesce(sum(views),0)::int AS pageviews, count(*)::int AS sessions,
                    coalesce(avg(greatest(dur_ms, extract(epoch FROM ended - started) * 1000)),0)::int AS avg_duration_ms,
                    coalesce(avg(CASE WHEN views <= 1 THEN 1 ELSE 0 END),0)::float AS bounce FROM sess`, args),
      this.pool.query(`SELECT date_trunc($3, ts) AS bucket, count(DISTINCT visitor)::int AS visitors, count(*) FILTER (WHERE type='pageview')::int AS pageviews
                  FROM public.lb_events WHERE project_id = $1 AND ts > now() - $2::interval GROUP BY 1 ORDER BY 1`, [...args, days <= 2 ? 'hour' : 'day']),
      this.pool.query(`${sessions} SELECT coalesce(nullif(referrer,''),'Direct') AS key, count(DISTINCT visitor)::int AS visitors FROM sess GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, args),
      this.pool.query(`SELECT path AS key, count(DISTINCT visitor)::int AS visitors FROM public.lb_events WHERE project_id = $1 AND ts > now() - $2::interval AND type='pageview' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, args),
      this.pool.query(`${sessions} SELECT coalesce(device,'Unknown') AS key, count(DISTINCT visitor)::int AS visitors FROM sess GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, args),
      this.pool.query(`${sessions} SELECT coalesce(country,'Unknown') AS key, count(DISTINCT visitor)::int AS visitors FROM sess GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, args),
      this.pool.query(`SELECT count(DISTINCT visitor)::int AS n FROM public.lb_events WHERE project_id = $1 AND ts > now() - interval '5 min'`, [projectId]),
    ])
    const k = kpi.rows[0]
    return {
      visitors: k.visitors, pageviews: k.pageviews, sessions: k.sessions,
      viewsPerVisit: k.sessions ? +(k.pageviews / k.sessions).toFixed(2) : 0,
      avgDurationMs: k.avg_duration_ms, bounce: k.bounce,
      live: live.rows[0].n as number,
      series: series.rows.map((r) => ({ t: new Date(r.bucket).toISOString(), visitors: r.visitors, pageviews: r.pageviews })),
      bySource: bySource.rows, byPage: byPage.rows, byDevice: byDevice.rows, byCountry: byCountry.rows,
    }
  }
}
