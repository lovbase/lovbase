import { useEffect, useMemo, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { analytics } from '../functions'
import { useT } from '../lib/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

// ── Analytics: single-series line, KPI row selects the series, four breakdowns. ──
// Monochrome: the line wears the ink colour; grid recedes; hover crosshair + tooltip.

type Data = Awaited<ReturnType<typeof analytics>>
type Metric = 'visitors' | 'pageviews'
type T = ReturnType<typeof useT>
const RANGES = (t: T) => [
  { d: 1, l: t('analytics.range.day', 'Last 24 hours') }, { d: 7, l: t('analytics.range.week', 'Last 7 days') },
  { d: 30, l: t('analytics.range.month', 'Last 30 days') }, { d: 90, l: t('analytics.range.quarter', 'Last 90 days') },
]

export function AnalyticsPane({ projectId }: { projectId: string }) {
  const t = useT()
  const ranges = RANGES(t)
  const fetchA = useServerFn(analytics)
  const [days, setDays] = useState(7)
  const [data, setData] = useState<Data | null>(null)
  const [metric, setMetric] = useState<Metric>('visitors')
  useEffect(() => {
    let alive = true
    fetchA({ data: { projectId, days } }).then((d) => alive && setData(d))
    const timer = setInterval(() => fetchA({ data: { projectId, days } }).then((d) => alive && setData(d)), 30_000)
    return () => { alive = false; clearInterval(timer) }
  }, [projectId, days])

  const fmtDur = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
  const tr = data?.traffic
  // Traffic from the edge, engagement from our own beacon — neither answers what the other does.
  const kpis: { key: Metric | 'vpv' | 'dur' | 'bounce'; label: string; value: string }[] = data ? [
    { key: 'visitors', label: t('analytics.visits', 'Visits'), value: String(tr?.visits ?? 0) },
    { key: 'pageviews', label: t('analytics.pageviews', 'Page views'), value: String(tr?.views ?? 0) },
    { key: 'vpv', label: t('analytics.viewsPerVisit', 'Pages per visit'), value: String(data.engagement.viewsPerVisit) },
    { key: 'dur', label: t('analytics.duration', 'Visit duration'), value: fmtDur(data.engagement.avgDurationMs) },
    { key: 'bounce', label: t('analytics.bounce', 'Bounce rate'), value: `${Math.round(data.engagement.bounce * 100)}%` },
  ] : []

  return (
    <div className="h-full overflow-auto bg-ink text-fg">
      <div className="max-w-5xl mx-auto px-8 py-7 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-[22px] font-semibold">{t('pane.analytics', 'Analytics')}</h2>
          <div className="flex items-center gap-4 text-[13px]">
            <span className="flex items-center gap-2 text-fg-mid"><span className={`size-2 rounded-full ${tr?.live ? 'bg-ok' : 'bg-fg-dim/50'}`} />{t('analytics.online', '{n} online').replace('{n}', String(tr?.live ?? 0))}</span>
            <Select value={days} onValueChange={(v) => v != null && setDays(v)}>
              <SelectTrigger className="border-edge bg-panel text-[13px] text-fg">
                <SelectValue>{(d: number) => ranges.find((r) => r.d === d)?.l}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ranges.map((r) => <SelectItem key={r.d} value={r.d}>{r.l}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        {data && !data.host && (
          <p className="rounded-xl border border-edge bg-panel px-4 py-3 text-[13px] text-fg-mid">
            {t('analytics.noApp', 'This project has no published app yet. Once it is published, traffic shows up here.')}
          </p>
        )}
        {data?.host && !data.edgeReady && (
          <p className="rounded-xl border border-edge bg-panel px-4 py-3 text-[13px] text-fg-mid">
            {t('analytics.noEdge', 'Cloudflare analytics is not configured (CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID), so the traffic numbers are empty for now.')}
          </p>
        )}

        <div className="rounded-xl border border-edge bg-panel overflow-hidden">
          <div className="grid grid-cols-5 border-b border-edge">
            {kpis.map((k) => {
              const selectable = k.key === 'visitors' || k.key === 'pageviews'
              const on = k.key === metric
              return (
                <button key={k.key} onClick={() => selectable && setMetric(k.key as Metric)} disabled={!selectable}
                  className={`text-left px-5 py-4 border-r border-edge last:border-r-0 transition-colors ${on ? 'bg-ink' : selectable ? 'hover:bg-ink/60 cursor-pointer' : 'cursor-default'}`}>
                  <p className={`text-[13px] ${on ? 'text-fg font-medium' : 'text-fg-mid'}`}>{k.label}</p>
                  <p className="text-[22px] font-semibold tabular-nums mt-0.5">{k.value}</p>
                </button>
              )
            })}
            {!data && Array.from({ length: 5 }).map((_, i) => <div key={i} className="px-5 py-4 border-r border-edge last:border-r-0"><div className="h-3 w-14 rounded bg-panel-2" /><div className="h-6 w-10 rounded bg-panel-2 mt-2" /></div>)}
          </div>
          <div className="p-5">
            {tr ? <LineChart points={tr.series.map((p) => ({ t: p.t, v: metric === 'visitors' ? p.visits : p.views }))} days={days} label={metric === 'visitors' ? t('analytics.visits', 'Visits') : t('analytics.pageviews', 'Page views')} /> : <div className="h-64" />}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Breakdown title={t('analytics.sources', 'Sources')} rows={tr?.bySource} />
          <Breakdown title={t('analytics.pages', 'Pages')} rows={tr?.byPage} />
          <Breakdown title={t('analytics.devices', 'Devices')} rows={tr?.byDevice} />
          <Breakdown title={t('analytics.countries', 'Country / region')} rows={tr?.byCountry} />
        </div>
        <p className="text-[12px] text-fg-dim">
          {t('analytics.note.edge', 'Visits, page views and the four breakdowns above are counted by Cloudflare at the edge, cover only the published app{host}, and cannot be blocked by browser extensions.').replace('{host}', data?.host ? ` (${data.host})` : '')}
          {' '}{t('analytics.note.beacon', 'Pages per visit, visit duration and bounce rate come from an anonymous script inside the app — the only thing that can see a session: no cookies, the visitor id rotates daily, and no IP is stored.')}
        </p>
      </div>
    </div>
  )
}

function Breakdown({ title, rows }: { title: string; rows?: { name: string; value: number }[] }) {
  const t = useT()
  const max = Math.max(1, ...(rows ?? []).map((r) => r.value))
  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      <div className="flex items-center justify-between text-[13px] mb-3"><span className="font-medium">{title}</span><span className="text-fg-dim">{t('analytics.pageviews', 'Page views')}</span></div>
      {!rows || rows.length === 0 ? <p className="text-[13px] text-fg-dim py-3">{t('analytics.noData', 'No data for this period.')}</p> : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.name} className="relative flex items-center justify-between text-[13px] px-2 py-1.5 rounded-md overflow-hidden">
              <span className="absolute inset-y-0 left-0 bg-panel-2 rounded-md" style={{ width: `${(r.value / max) * 100}%` }} />
              <span className="relative truncate pr-4">{r.name}</span><span className="relative tabular-nums text-fg-mid">{r.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Plain SVG line: one series, recessive grid, crosshair tooltip on hover, 2px stroke, faint area. */
function LineChart({ points, days, label }: { points: { t: string; v: number }[]; days: number; label: string }) {
  const W = 880, H = 240, PL = 36, PR = 12, PT = 12, PB = 28
  const [hover, setHover] = useState<number | null>(null)
  // Fill missing buckets so the axis is continuous.
  const series = useMemo(() => {
    const step = days <= 2 ? 3600_000 : 86_400_000
    const end = new Date(); end.setMinutes(0, 0, 0); if (step > 3600_000) end.setHours(0)
    const start = end.getTime() - step * (days <= 2 ? 24 : days - 1)
    const map = new Map(points.map((p) => [Math.floor(new Date(p.t).getTime() / step) * step, p.v]))
    const out: { t: number; v: number }[] = []
    for (let t = Math.floor(start / step) * step; t <= end.getTime(); t += step) out.push({ t, v: map.get(t) ?? 0 })
    return out
  }, [points, days])
  const maxV = Math.max(4, ...series.map((p) => p.v))
  const ticks = niceTicks(maxV)
  const x = (i: number) => PL + (i / Math.max(1, series.length - 1)) * (W - PL - PR)
  const y = (v: number) => PT + (1 - v / ticks[ticks.length - 1]) * (H - PT - PB)
  const path = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const area = `${path} L${x(series.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`
  const fmt = (t: number) => days <= 2 ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })
  const labelEvery = Math.max(1, Math.ceil(series.length / 6))

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-64 select-none"
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; setHover(Math.round(((px - PL) / (W - PL - PR)) * (series.length - 1))) }}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="var(--t-edge)" strokeWidth="1" />
            <text x={PL - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--t-fg-dim)">{t}</text>
          </g>
        ))}
        {series.map((p, i) => i % labelEvery === 0 && <text key={p.t} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--t-fg-dim)">{fmt(p.t)}</text>)}
        <path d={area} fill="var(--t-fg)" opacity="0.06" />
        <path d={path} fill="none" stroke="var(--t-fg)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover != null && series[hover] && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PT} y2={H - PB} stroke="var(--t-fg-dim)" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(series[hover].v)} r="4" fill="var(--t-fg)" stroke="var(--t-panel)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hover != null && series[hover] && (
        <div className="pointer-events-none absolute -translate-x-1/2 bg-fg text-ink text-[12px] px-2.5 py-1.5 rounded-md whitespace-nowrap"
          style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(series[hover].v) / H) * 100}%`, transform: 'translate(-50%, calc(-100% - 10px))' }}>
          {fmt(series[hover].t)} · {label} {series[hover].v}
        </div>
      )}
    </div>
  )
}

function niceTicks(max: number): number[] {
  const step = Math.pow(10, Math.floor(Math.log10(max))) * (max / Math.pow(10, Math.floor(Math.log10(max))) > 5 ? 2 : 1)
  const top = Math.ceil(max / step) * step
  const out: number[] = []
  for (let v = 0; v <= top; v += step) out.push(v)
  return out.length > 6 ? out.filter((_, i) => i % 2 === 0) : out
}
