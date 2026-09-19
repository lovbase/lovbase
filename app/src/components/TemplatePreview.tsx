import { useEffect, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { templatePreview } from '../functions'
import { Database, Table2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { Template } from '@lovbase/core/templates'

const STATUS_STYLE: Record<string, string> = {
  '已成交': 'bg-ok/15 text-ok', '赢单': 'bg-ok/15 text-ok', '已签到': 'bg-ok/15 text-ok', '完成': 'bg-ok/15 text-ok', '已解决': 'bg-ok/15 text-ok', '已发布': 'bg-ok/15 text-ok', '入库': 'bg-ok/15 text-ok',
  '跟进中': 'bg-db/15 text-db', '进行中': 'bg-db/15 text-db', '处理中': 'bg-db/15 text-db', '写作中': 'bg-db/15 text-db', '方案报价': 'bg-db/15 text-db', '需求确认': 'bg-db/15 text-db',
  '潜在': 'bg-panel-2 text-fg-mid', '待办': 'bg-panel-2 text-fg-mid', '新建': 'bg-panel-2 text-fg-mid', '想法': 'bg-panel-2 text-fg-mid', '未签到': 'bg-panel-2 text-fg-mid', '出库': 'bg-warn/15 text-warn',
}

/** A realistic mock of the app a template produces, rendered with sample rows. */
export function TemplateApp({ t, compact = false }: { t: Template; compact?: boolean }) {
  const [active, setActive] = useState(0)
  const table = t.preview[active]
  return (
    <div className={`flex bg-paper text-stone-900 ${compact ? 'text-[11px]' : 'text-[13px]'} h-full`}>
      <aside className={`${compact ? 'w-28' : 'w-44'} shrink-0 border-r border-stone-200 bg-stone-50 flex flex-col`}>
        <div className={`flex items-center gap-2 ${compact ? 'h-9 px-2.5' : 'h-12 px-3.5'} border-b border-stone-200 font-semibold`}>
          <span className={`${compact ? 'size-5' : 'size-6'} rounded-md bg-stone-900 text-white grid place-items-center`}><Database className={compact ? 'size-3' : 'size-3.5'} /></span>
          <span className="truncate">{t.name}</span>
        </div>
        <nav className={`${compact ? 'p-1.5' : 'p-2'} space-y-0.5`}>
          {t.tables.map((name) => {
            const idx = t.preview.findIndex((p) => p.name === name)
            const on = idx === active
            return (
              <button key={name} onClick={(e) => { e.stopPropagation(); if (idx >= 0) setActive(idx) }}
                className={`w-full flex items-center gap-1.5 rounded-md ${compact ? 'px-2 py-1' : 'px-2.5 py-1.5'} text-left ${on ? 'bg-stone-200/70 text-stone-900 font-medium' : 'text-stone-500'} ${idx < 0 ? 'opacity-60' : ''}`}>
                <Table2 className={compact ? 'size-3' : 'size-3.5'} /> {name}
              </button>
            )
          })}
        </nav>
      </aside>
      <div className={`flex-1 min-w-0 ${compact ? 'p-3' : 'p-6'}`}>
        <div className="flex items-center justify-between">
          <div>
            <p className={`${compact ? 'text-[13px]' : 'text-[19px]'} font-semibold tracking-tight`}>{table.name}</p>
            <p className="text-stone-400">{table.rows.length} 条记录</p>
          </div>
          <span className={`rounded-md bg-stone-900 text-white ${compact ? 'px-2 py-0.5' : 'px-3 py-1.5'}`}>+ 新增</span>
        </div>
        <div className={`${compact ? 'mt-2' : 'mt-4'} rounded-lg border border-stone-200 bg-white overflow-hidden`}>
          <table className="w-full">
            <thead><tr className="text-left text-stone-500 border-b border-stone-200">{table.columns.map((c) => <th key={c} className={`${compact ? 'px-2 py-1' : 'px-3 py-2'} font-medium`}>{c}</th>)}</tr></thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i} className="border-b border-stone-100 last:border-0">
                  {r.map((v, j) => (
                    <td key={j} className={`${compact ? 'px-2 py-1' : 'px-3 py-2'} whitespace-nowrap ${/[¥\d]/.test(v) && j > 0 ? 'tabular-nums' : ''}`}>
                      {j === table.status ? <span className={`inline-block rounded-full ${compact ? 'px-1.5' : 'px-2 py-0.5'} ${STATUS_STYLE[v] ?? 'bg-panel-2 text-fg-mid'}`}>{v}</span> : v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export function TemplatePreviewDialog({ t, onClose, onUse, busy }: { t: Template | null; onClose: () => void; onUse: (t: Template) => void; busy: boolean }) {
  const load = useServerFn(templatePreview)
  const [live, setLive] = useState<{ id: string; url: string } | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    setErr('')
    if (!t) return
    let alive = true
    load({ data: { templateId: t.id } }).then((r) => alive && setLive({ id: t.id, url: r.previewUrl })).catch((e) => alive && setErr(e.message))
    return () => { alive = false }
  }, [t?.id])
  const url = live?.id === t?.id ? live?.url : null
  return (
    <Dialog open={!!t} onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton className="p-0 overflow-hidden sm:max-w-[94vw] w-[94vw] h-[90vh] gap-0 bg-panel border-edge">
        {t && (
          <>
            <DialogTitle className="sr-only">{t.name}</DialogTitle>
            <div className="flex h-full">
              <div className="flex-1 min-w-0 border-r border-edge bg-panel-2 p-5">
                <div className="h-full rounded-xl border border-edge overflow-hidden shadow-sm relative bg-white">
                  {url ? <iframe src={url} title={t.name} className="w-full h-full border-0" /> : <TemplateApp t={t} />}
                  {!url && (
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-panel border border-edge text-[12px] text-fg-mid shadow-sm">
                      {err ? <span className="text-fg">实时预览失败:{err}</span> : <><span className="size-3 rounded-full border-2 border-edge-strong border-t-fg animate-spin" /> 正在启动真实应用,先看示例…</>}
                    </div>
                  )}
                </div>
              </div>
              <div className="w-80 shrink-0 p-6 flex flex-col">
                <p className="font-display text-[20px] font-semibold">{t.name}</p>
                <p className="text-fg-mid text-[13px] mt-1">{t.tagline}</p>
                <p className="eyebrow mt-6 mb-2">包含的表</p>
                <div className="flex flex-wrap gap-1.5">{t.tables.map((x) => <span key={x} className="px-2 py-0.5 rounded-md bg-panel-2 border border-edge text-[12px]">{x}</span>)}</div>
                <p className="eyebrow mt-6 mb-2">会交给 agent 的描述</p>
                <p className="text-[12.5px] text-fg-mid leading-relaxed">{t.prompt}</p>
                <p className="text-[11.5px] text-fg-dim mt-3">{url ? '这是真实运行的演示应用,可以点进去操作。' : '预览里的数据是示例。'}创建后 agent 会为你建一份自己的表,随时可以改结构。</p>
                <button onClick={() => onUse(t)} disabled={busy}
                  className="mt-auto w-full py-2.5 bg-accent text-on-accent rounded-lg text-[13.5px] font-medium hover:bg-accent-soft disabled:opacity-50 transition-colors cursor-pointer">
                  {busy ? '创建中…' : '使用这个模板'}
                </button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
