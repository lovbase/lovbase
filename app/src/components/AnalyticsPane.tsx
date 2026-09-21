import { useEffect, useMemo, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { analytics } from '../functions'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

// ── Analytics: single-series line, KPI row selects the series, four breakdowns. ──
// Monochrome: the line wears the ink colour; grid recedes; hover crosshair + tooltip.

type Data = Awaited<ReturnType<typeof analytics>>
type Metric = 'visitors' | 'pageviews'
const RANGES = [{ d: 1, l: '最近 24 小时' }, { d: 7, l: '最近 7 天' }, { d: 30, l: '最近 30 天' }, { d: 90, l: '最近 90 天' }]

export function AnalyticsPane({ projectId }: { projectId: string }) {
  const fetchA = useServerFn(analytics)
  const [days, setDays] = useState(7)
  const [data, setData] = useState<Data | null>(null)
  const [metric, setMetric] = useState<Metric>('visitors')
  useEffect(() => {
    let alive = true
    fetchA({ data: { projectId, days } }).then((d) => alive && setData(d))
    const t = setInterval(() => fetchA({ data: { projectId, days } }).then((d) => alive && setData(d)), 30_000)
    return () => { alive = false; clearInterval(t) }
  }, [projectId, days])

  const fmtDur = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
  const kpis: { key: Metric | 'vpv' | 'dur' | 'bounce'; label: string; value: string }[] = data ? [
    { key: 'visitors', label: '访客', value: String(data.visitors) },
    { key: 'pageviews', label: '页面浏览', value: String(data.pageviews) },
    { key: 'vpv', label: '每次访问页数', value: String(data.viewsPerVisit) },
    { key: 'dur', label: '访问时长', value: fmtDur(data.avgDurationMs) },
    { key: 'bounce', label: '跳出率', value: `${Math.round(data.bounce * 100)}%` },
  ] : []

  return (
    <div className="h-full overflow-auto bg-ink text-fg">
      <div className="max-w-5xl mx-auto px-8 py-7 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-[22px] font-semibold">分析</h2>
          <div className="flex items-center gap-4 text-[13px]">
            <span className="flex items-center gap-2 text-fg-mid"><span className={`size-2 rounded-full ${data?.live ? 'bg-ok' : 'bg-fg-dim/50'}`} />{data?.live ?? 0} 人在线</span>
            <Select value={days} onValueChange={(v) => v != null && setDays(v)}>
              <SelectTrigger className="border-edge bg-panel text-[13px] text-fg">
                <SelectValue>{(d: number) => RANGES.find((r) => r.d === d)?.l}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {RANGES.map((r) => <SelectItem key={r.d} value={r.d}>{r.l}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

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
            {data ? <LineChart points={data.series.map((p) => ({ t: p.t, v: p[metric] }))} days={days} label={metric === 'visitors' ? '访客' : '页面浏览'} /> : <div className="h-64" />}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Breakdown title="来源" rows={data?.bySource} />
          <Breakdown title="页面" rows={data?.byPage} />
          <Breakdown title="设备" rows={data?.byDevice} />
          <Breakdown title="国家 / 地区" rows={data?.byCountry} />
        </div>
        <p className="text-[12px] text-fg-dim">数据来自应用里内置的匿名统计脚本:不用 cookie,访客 id 每天轮换,不存 IP。预览和已发布的应用都会计入。</p>
      </div>
    </div>
  )
}

function Breakdown({ title, rows }: { title: string; rows?: { key: string; visitors: number }[] }) {
  const max = Math.max(1, ...(rows ?? []).map((r) => r.visitors))
  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      <div className="flex items-center justify-between text-[13px] mb-3"><span className="font-medium">{title}</span><span className="text-fg-dim">访客</span></div>
      {!rows || rows.length === 0 ? <p className="text-[13px] text-fg-dim py-3">这个时间段没有数据。</p> : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.key} className="relative flex items-center justify-between text-[13px] px-2 py-1.5 rounded-md overflow-hidden">
              <span className="absolute inset-y-0 left-0 bg-panel-2 rounded-md" style={{ width: `${(r.visitors / max) * 100}%` }} />
              <span className="relative truncate pr-4">{r.key}</span><span className="relative tabular-nums text-fg-mid">{r.visitors}</span>
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
