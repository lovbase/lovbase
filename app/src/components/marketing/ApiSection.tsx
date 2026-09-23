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
    note: t('api.rest.note', 'Any frontend can read and write its own tables; auth is the project API token.'),
    lines: [
      "const res = await fetch(`/api/data/${projectId}/sql`, {",
      "  method: 'POST',",
      '  headers: {',
      '    Authorization: `Bearer ${apiToken}`,',
      "    'Content-Type': 'application/json',",
      '  },',
      '  body: JSON.stringify({',
      "    sql: 'select name, city from customers where city = $1',",
      t('api.rest.code.params', "    params: ['Shanghai'],"),
      '  }),',
      '})',
      '',
      t('api.rest.code.c1', '// Runs as the ws_<id> role, one statement, inside a transaction.'),
      t('api.rest.code.c2', '// That role only has SELECT/INSERT/UPDATE/DELETE on its own schema.'),
    ],
  },
  {
    id: 'psql',
    label: 'psql',
    note: t('api.psql.note', 'It is just Postgres. psql, DBeaver, Metabase and Prisma connect straight to it.'),
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
    note: t('api.schema.note', 'Structural change has exactly one path: IR to diff to whitelisted DDL, with destructive changes held for your confirmation.'),
    lines: [
      t('api.schema.code.get', 'GET  /api/data/:id/schema   → { ir, ddl, schema }'),
      t('api.schema.code.post', 'POST /api/data/:id/schema   → { ir } or { message }'),
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
              eyebrow={t('footer.api', 'Data API')}
              title={t('api.title', 'Once it is generated, the data is still yours')}
              sub={t('api.sub', 'Every project gets its own Postgres schema plus a role with DML permissions only. Connect directly with the connection string, or serve a frontend of your own through the REST endpoint.')}
            />
            <ul className="mt-7 space-y-3">
              {[
                t('api.point1', 'The LLM never writes SQL; it emits IR, and deterministic code compiles that into DDL'),
                t('api.point2', 'The executing role has no CREATE / ALTER / DROP permission'),
                t('api.point3', 'Export the whole database as SQL and take it with you'),
              ].map((line) => (
                <li key={line} className="flex gap-2.5 text-[13.5px] leading-relaxed text-fg-mid">
                  <span className="mt-[9px] size-1 rounded-full bg-fg-dim shrink-0" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-edge bg-panel overflow-hidden min-w-0">
            <div role="tablist" aria-label={t('api.aria.tabs', 'Data API examples')} className="flex items-center gap-1 px-2.5 py-2 border-b border-edge bg-panel-2">
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
