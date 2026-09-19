import { useState } from 'react'
import { useT } from '../../lib/i18n'
import { Container, SectionHead } from './MarketingChrome'

type T = ReturnType<typeof useT>
type TabId = 'rest' | 'psql' | 'schema'

// Endpoints and semantics here mirror the real data API (README + src/routes/api.data.*).
const tabs = (t: T): { id: TabId; label: string; note: string; lines: string[] }[] => [
  {
    id: 'rest',
    label: 'REST',
    note: t('api.rest.note', '任何前端都能读写自己的表,鉴权是项目的 API token。'),
    lines: [
      "const res = await fetch(`/api/data/${projectId}/sql`, {",
      "  method: 'POST',",
      '  headers: {',
      '    Authorization: `Bearer ${apiToken}`,',
      "    'Content-Type': 'application/json',",
      '  },',
      '  body: JSON.stringify({',
      "    sql: 'select name, city from customers where city = $1',",
      t('api.rest.code.params', "    params: ['上海'],"),
      '  }),',
      '})',
      '',
      t('api.rest.code.c1', '// 以 ws_<id> 角色、单条语句、事务内执行。'),
      t('api.rest.code.c2', '// 该角色只有自己 schema 的 SELECT/INSERT/UPDATE/DELETE。'),
    ],
  },
  {
    id: 'psql',
    label: 'psql',
    note: t('api.psql.note', '它就是一个 Postgres。psql、DBeaver、Metabase、Prisma 都能直接连。'),
    lines: [
      '$ psql "postgres://ws_a1b2c3:••••@db.example.com:5432/lovbase"',
      '',
      'lovbase=> \\dt',
      '  Schema  |    Name    | Type',
      ' ---------+------------+-------',
      '  p_a1b2  | customers  | table',
      '  p_a1b2  | contacts   | table',
      '  p_a1b2  | follow_ups | table',
      '',
      'lovbase=> select city, count(*) from customers group by 1;',
    ],
  },
  {
    id: 'schema',
    label: 'Schema',
    note: t('api.schema.note', '改结构只有这一条路:IR → diff → 白名单 DDL,破坏性变更停在待你确认。'),
    lines: [
      t('api.schema.code.get', 'GET  /api/data/:id/schema   → { ir, ddl, schema }'),
      t('api.schema.code.post', 'POST /api/data/:id/schema   → { ir } 或 { message }'),
      '',
      '{',
      '  "ir": {',
      '    "entities": [',
      '      { "id": "e_1", "name": "customers", "fields": [ … ] }',
      '    ]',
      '  },',
      '  "schema": "p_a1b2"',
      '}',
    ],
  },
]

export function ApiSection() {
  const t = useT()
  const [tab, setTab] = useState<TabId>('rest')
  const TABS = tabs(t)
  const active = TABS.find((x) => x.id === tab)!

  return (
    <section id="api" className="scroll-mt-20 py-20 sm:py-24 border-t border-edge">
      <Container>
        <div className="grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] gap-10 lg:gap-14 items-start">
          <div>
            <SectionHead
              eyebrow={t('footer.api', '数据 API')}
              title={t('api.title', '生成完了,数据还在你手里')}
              sub={t('api.sub', '每个项目一个独立的 Postgres schema,加一个只有 DML 权限的角色。你可以用连接串直连,也可以用 REST 接口给自己写的前端供数。')}
            />
            <ul className="mt-7 space-y-3">
              {[
                t('api.point1', 'LLM 从不直接写 SQL,它只产出 IR,由确定性代码编译成 DDL'),
                t('api.point2', '执行角色没有 CREATE / ALTER / DROP 权限'),
                t('api.point3', '随时导出 SQL,把数据整份搬走'),
              ].map((line) => (
                <li key={line} className="flex gap-2.5 text-[13.5px] leading-relaxed text-fg-mid">
                  <span className="mt-[9px] size-1 rounded-full bg-fg-dim shrink-0" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-edge bg-panel overflow-hidden min-w-0">
            <div role="tablist" aria-label={t('api.aria.tabs', '数据接口示例')} className="flex items-center gap-1 px-2.5 py-2 border-b border-edge bg-panel-2">
              {TABS.map((x) => (
                <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)}
                  className={`px-2.5 py-1 rounded-md font-mono text-[11.5px] transition-colors cursor-pointer ${
                    tab === x.id ? 'bg-panel border border-edge text-fg' : 'border border-transparent text-fg-dim hover:text-fg-mid'
                  }`}>
                  {x.label}
                </button>
              ))}
            </div>
            <pre className="p-4 sm:p-5 overflow-x-auto text-[12px] leading-[1.75] font-mono text-fg-mid">
              <code>{active.lines.join('\n')}</code>
            </pre>
            <p className="px-4 sm:px-5 py-3 border-t border-edge text-[12.5px] text-fg-dim">{active.note}</p>
          </div>
        </div>
      </Container>
    </section>
  )
}
