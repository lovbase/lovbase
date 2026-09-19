import { useT } from '../../lib/i18n'

/**
 * A static, hand-built mock of the product: the same three moments the builder goes through —
 * you type, a real schema appears, an app renders on top of it. No screenshots, no colour.
 */
type T = ReturnType<typeof useT>

const TABLES = [
  { name: 'customers', cols: ['id  uuid  pk', 'name  text', 'city  text', 'created_at  timestamptz'] },
  { name: 'contacts', cols: ['id  uuid  pk', 'customer_id  → customers', 'phone  text'] },
  { name: 'follow_ups', cols: ['id  uuid  pk', 'customer_id  → customers', 'note  text', 'due_on  date'] },
]

const rows = (t: T) => [
  [t('hero.row1.name', '明远科技'), t('hero.row1.city', '上海'), t('hero.status.open', '跟进中')],
  [t('hero.row2.name', '和顺贸易'), t('hero.row2.city', '广州'), t('hero.status.won', '已成交')],
  [t('hero.row3.name', '青禾食品'), t('hero.row3.city', '成都'), t('hero.status.todo', '待联系')],
  [t('hero.row4.name', '沐光设计'), t('hero.row4.city', '杭州'), t('hero.status.open', '跟进中')],
]

export function HeroVisual() {
  const t = useT()
  const ROWS = rows(t)

  return (
    <div className="rounded-2xl border border-edge bg-panel overflow-hidden
                    shadow-[0_1px_2px_rgba(0,0,0,.04),0_24px_60px_-30px_rgba(0,0,0,.25)]
                    dark:shadow-[0_24px_60px_-30px_rgba(0,0,0,.8)]">
      <div className="h-9 flex items-center gap-2 px-3.5 border-b border-edge bg-panel-2">
        <span className="flex gap-1.5">
          <i className="size-2 rounded-full bg-edge-strong" />
          <i className="size-2 rounded-full bg-edge-strong" />
          <i className="size-2 rounded-full bg-edge-strong" />
        </span>
        <span className="mx-auto font-mono text-[11px] text-fg-dim">lovbase / {t('hero.appName', '客户管理')}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-edge">
        <Pane label={t('hero.pane.chat', '对话')}>
          <div className="rounded-xl rounded-br-sm bg-panel-2 border border-edge px-3 py-2.5 text-[12.5px] leading-relaxed text-fg">
            {t('hero.chat.prompt', '做一个客户管理系统,记录客户、联系人和跟进记录')}
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-fg-mid">
            {t('hero.chat.reply', '已设计 3 张表,并把联系人和跟进记录挂到客户上。')}
          </p>
          <ul className="mt-3 space-y-1.5 font-mono text-[11.5px] text-fg-mid">
            {TABLES.map((tb) => (
              <li key={tb.name} className="flex items-center gap-2">
                <span className="text-fg-dim">CREATE</span>
                <span className="px-1.5 py-0.5 rounded-md bg-panel-2 border border-edge text-fg">{tb.name}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11.5px] text-fg-dim">{t('hero.chat.noDrop', '没有 DROP,没有丢数据的改动。')}</p>
        </Pane>

        <Pane label="Postgres schema">
          <div className="space-y-2">
            {TABLES.map((tb) => (
              <div key={tb.name} className="rounded-lg border border-edge bg-panel-2/60 overflow-hidden">
                <p className="px-2.5 py-1.5 font-mono text-[11.5px] text-fg border-b border-edge">{tb.name}</p>
                <ul className="px-2.5 py-1.5 space-y-1 font-mono text-[10.5px] text-fg-dim">
                  {tb.cols.map((c) => <li key={c} className="truncate whitespace-pre">{c}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </Pane>

        <Pane label={t('hero.pane.ui', 'Boris 生成的界面')} className="hidden md:block">
          <div className="rounded-lg border border-edge overflow-hidden">
            <div className="px-2.5 py-1.5 border-b border-edge bg-panel-2 flex items-center justify-between">
              <span className="text-[11.5px] text-fg">{t('hero.ui.customers', '客户')}</span>
              <span className="text-[10.5px] text-fg-dim border border-edge rounded-md px-1.5 py-0.5">{t('hero.ui.new', '新增')}</span>
            </div>
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10.5px] text-fg-dim">
                  {[t('hero.ui.col.name', '名称'), t('hero.ui.col.city', '城市'), t('hero.ui.col.status', '状态')].map((h) => (
                    <th key={h} className="font-normal px-2.5 py-1.5 border-b border-edge">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r[0]} className="text-[11px] text-fg-mid">
                    {r.map((c, i) => (
                      <td key={i} className="px-2.5 py-[7px] border-b border-edge last:border-b-0 truncate">{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 rounded-lg border border-edge bg-panel-2/60 px-2.5 py-2">
            <p className="font-mono text-[10.5px] text-fg-dim leading-relaxed">
              psql postgres://ws_…@…:5432/lovbase
            </p>
            <p className="text-[11px] text-fg-mid mt-1">{t('hero.ui.sameData', '同一份数据,任何客户端都能连。')}</p>
          </div>
        </Pane>
      </div>
    </div>
  )
}

function Pane({ label, className = '', children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`p-4 sm:p-5 min-w-0 ${className}`}>
      <p className="eyebrow uppercase tracking-[.14em] mb-3">{label}</p>
      {children}
    </div>
  )
}
