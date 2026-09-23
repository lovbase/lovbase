import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '../../config/config.service'

/**
 * Traffic for a published app, counted by Cloudflare rather than by us.
 *
 * Every published app is a subdomain of the apps zone, behind Cloudflare, which already injects a
 * page-load beacon and keeps the numbers per hostname. So the figures arrive split by app with no
 * code of ours running inside anyone's generated application, and nothing for us to store.
 *
 * Two datasets could answer this and they are not equal. Zone HTTP analytics counts every request,
 * so a page load is buried among its own stylesheets; it refuses the referrer dimensions on a Free
 * zone — and a zone stays Free no matter what the Workers plan costs, which is the trap — and it
 * will not answer a range wider than 30 days. The RUM dataset counts page loads, gives referrer on
 * the free tier, and goes back 93. All four numbers were established against the live API; the
 * documentation states none of them.
 *
 * What no aggregate can do is stitch page loads into sessions, so there is no time-on-page and no
 * bounce rate. Those need a script of our own in someone else's app, which is not worth it.
 */

type Group<D> = { count: number; sum: { visits: number }; dimensions: D }

export type EdgeTraffic = {
  /** Page loads. */
  views: number
  /** Arrivals from somewhere else — Cloudflare's own definition of a visit. */
  visits: number
  /** Live is the last five minutes, which is as close to "now" as an aggregate gets. */
  live: number
  series: { t: string; views: number; visits: number }[]
  byPage: { name: string; value: number }[]
  bySource: { name: string; value: number }[]
  byDevice: { name: string; value: number }[]
  byCountry: { name: string; value: number }[]
  byBrowser: { name: string; value: number }[]
}

/** As far back as the account will answer. Asking for more is an error, not an empty result. */
export const MAX_DAYS = 90

const EMPTY: EdgeTraffic = { views: 0, visits: 0, live: 0, series: [], byPage: [], bySource: [], byDevice: [], byCountry: [], byBrowser: [] }

const GQL = 'https://api.cloudflare.com/client/v4/graphql'

/** Add up one dimension across rows grouped by several, and keep the top few. */
function roll<D>(rows: Group<D>[], name: (d: D) => string) {
  const by = new Map<string, number>()
  for (const g of rows) {
    const k = name(g.dimensions)
    by.set(k, (by.get(k) ?? 0) + g.count)
  }
  return [...by].map(([n, value]) => ({ name: n, value })).toSorted((a, b) => b.value - a.value).slice(0, 8)
}

/** An empty referer host is someone arriving without one — typed, bookmarked, or from an app. */
const DIRECT = 'Direct'

@Injectable()
export class EdgeAnalyticsService {
  private readonly log = new Logger('edge-analytics')

  constructor(private readonly cfg: ConfigService) {}

  get enabled() { return this.cfg.edgeAnalyticsConfigured }

  /**
   * One app's traffic over the last `days`, capped at what the account will answer.
   *
   * Three queries rather than one: every dimension together returns the cartesian product of day ×
   * page × referrer × device × country, a great many rows to download only to add back up.
   */
  async forHost(host: string, days: number): Promise<EdgeTraffic> {
    if (!this.enabled) return EMPTY
    const to = new Date()
    const from = new Date(to.getTime() - Math.min(days, MAX_DAYS) * 86400_000)

    const [series, pages, who, recent] = await Promise.all([
      this.groups<{ date: string }>(host, from, to, 400, 'date'),
      this.groups<{ requestPath: string; refererHost: string }>(host, from, to, 60, 'requestPath refererHost'),
      this.groups<{ deviceType: string; countryName: string; userAgentBrowser: string }>(
        host, from, to, 200, 'deviceType countryName userAgentBrowser'),
      this.groups<{ datetimeFiveMinutes: string }>(host, new Date(to.getTime() - 5 * 60_000), to, 2, 'datetimeFiveMinutes'),
    ])

    return {
      views: series.reduce((n, g) => n + g.count, 0),
      visits: series.reduce((n, g) => n + g.sum.visits, 0),
      live: recent.reduce((n, g) => n + g.sum.visits, 0),
      series: series
        .map((g) => ({ t: g.dimensions.date, views: g.count, visits: g.sum.visits }))
        .toSorted((a, b) => a.t.localeCompare(b.t)),
      byPage: roll(pages, (d) => d.requestPath || '/'),
      bySource: roll(pages, (d) => d.refererHost || DIRECT),
      byDevice: roll(who, (d) => d.deviceType || 'Unknown'),
      byCountry: roll(who, (d) => d.countryName || 'Unknown'),
      byBrowser: roll(who, (d) => d.userAgentBrowser || 'Unknown'),
    }
  }

  private async groups<D>(host: string, from: Date, to: Date, limit: number, dims: string): Promise<Group<D>[]> {
    const query = `query($a:String!,$from:Time!,$to:Time!,$host:String!){
      viewer { accounts(filter:{accountTag:$a}) {
        rumPageloadEventsAdaptiveGroups(limit:${limit},
          filter:{datetime_geq:$from, datetime_leq:$to, requestHost:$host, bot:0},
          orderBy:[count_DESC]) {
          count sum { visits } dimensions { ${dims} }
        } } } }`
    const res = await fetch(GQL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.cfg.env.CLOUDFLARE_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { a: this.cfg.env.CLOUDFLARE_ACCOUNT_ID, from: from.toISOString(), to: to.toISOString(), host },
      }),
    })
    const body = await res.json() as {
      data?: { viewer?: { accounts?: { rumPageloadEventsAdaptiveGroups: Group<D>[] }[] } }
      errors?: { message: string }[]
    }
    // GraphQL answers 200 with an errors array, so the status alone says nothing.
    if (body.errors?.length) throw new Error(body.errors[0].message)
    return body.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups ?? []
  }
}
