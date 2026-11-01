import { Logger } from '@nestjs/common'

export type PublicPrice = { inPer1M: number; outPer1M: number; cachedInPer1M?: number; source: 'vercel' | 'openrouter' }

/**
 * List prices from public model catalogs, for endpoints whose own /models carries none — an
 * OpenAI-compatible proxy usually answers with ids alone. Vercel AI Gateway first, OpenRouter for
 * what it lacks; both are public and need no key. A model matches on its name with any
 * `provider/` prefix, date suffix and dot-versus-dash difference ignored, which is how the same
 * model is spelled across gateways. A name only one gateway uses matches nothing, and stays for
 * the admin to price by hand.
 */
const SOURCES = [
  { source: 'vercel', url: 'https://ai-gateway.vercel.sh/v1/models' },
  { source: 'openrouter', url: 'https://openrouter.ai/api/v1/models' },
] as const

const TTL_MS = 6 * 60 * 60_000
const RETRY_MS = 5 * 60_000
const log = new Logger('public-prices')
let cache: { at: number; ok: boolean; index: Map<string, PublicPrice> } | null = null
let inflight: Promise<Map<string, PublicPrice>> | null = null

/** `openai/gpt-5.1-2025-11-13` and `gpt-5-1` are the same key. */
export const priceKey = (id: string) =>
  id.toLowerCase().split('/').pop()!.replace(/[-@]\d{8}$|-\d{4}-\d{2}-\d{2}$/, '').replace(/\./g, '-')

const per1M = (v: unknown) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v) * 1e6 * 1e4) / 1e4 : undefined)

async function load(): Promise<Map<string, PublicPrice>> {
  const index = new Map<string, PublicPrice>()
  let ok = false
  for (const { source, url } of SOURCES) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = (await r.json()) as { data?: { id: string; pricing?: Record<string, unknown> }[] }
      for (const m of body.data ?? []) {
        const p = m.pricing
        const inPer1M = per1M(p?.input ?? p?.prompt), outPer1M = per1M(p?.output ?? p?.completion)
        // A free or unpriced listing says nothing useful about what the model costs elsewhere.
        if (inPer1M == null || outPer1M == null || (inPer1M === 0 && outPer1M === 0)) continue
        const key = priceKey(m.id)
        if (!index.has(key)) index.set(key, { inPer1M, outPer1M, cachedInPer1M: per1M(p?.input_cache_read), source })
      }
      ok = true
    } catch (e) {
      log.warn(`${source} catalog unavailable: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  cache = { at: Date.now(), ok, index }
  return index
}

/** Cached for hours; a failed fetch is retried after minutes rather than on every call. */
export async function publicPrices(): Promise<Map<string, PublicPrice>> {
  if (cache && Date.now() - cache.at < (cache.ok ? TTL_MS : RETRY_MS)) return cache.index
  inflight ??= load().finally(() => { inflight = null })
  return inflight
}
