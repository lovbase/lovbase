import { isDestructive, type Change } from '@lovbase/core/diff'
import { useT } from '../lib/i18n'

export function ChangeList({ changes, plain = false }: { changes: Change[]; plain?: boolean }) {
  const t = useT()
  return (
    <ul className={plain ? 'space-y-0.5' : 'border border-edge/80 rounded-lg divide-y divide-edge/60 overflow-hidden bg-panel/40'}>
      {changes.map((c, i) => {
        const destructive = isDestructive(c)
        return (
          <li key={i} className={`flex items-center gap-2.5 text-[12px] text-fg-mid ${plain ? 'py-0.5' : 'px-3 py-1.5'}`}>
            {plain
              ? <span className={`size-1 rounded-full shrink-0 ${destructive ? 'bg-fg' : 'bg-fg-dim'}`} />
              : <span className={`font-mono text-[9.5px] tracking-wide px-1.5 py-px rounded-sm shrink-0 ${
                  destructive ? 'bg-panel-2 text-fg-mid' : 'bg-panel-2 text-fg-dim border border-edge'
                }`}>{c.kind}</span>}
            <span className="text-fg-mid">{describeChange(t, c)}</span>
          </li>
        )
      })}
    </ul>
  )
}

function describeChange(t: ReturnType<typeof useT>, c: Change): string {
  const fill = (s: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), s)
  switch (c.kind) {
    case 'create_entity': return fill(t('change.createEntity', 'Create table {name} ({db}), {n} fields'), { name: c.entity.name, db: c.entity.dbName, n: c.entity.fields.length })
    case 'drop_entity': return fill(t('change.dropEntity', 'Drop table {name} ({db}) and all its data'), { name: c.name, db: c.dbName })
    case 'rename_entity': return fill(t('change.renameEntity', 'Rename table {from} to {to} (data kept)'), { from: c.from, to: c.to })
    case 'add_field': return fill(t('change.addField', '{table}: add field {name} ({db})'), { table: c.entityDb, name: c.field.name, db: c.field.dbName })
    case 'drop_field': return fill(t('change.dropField', '{table}: drop field {name} ({db}) and its data'), { table: c.entityDb, name: c.name, db: c.dbName })
    case 'rename_field': return fill(t('change.renameField', '{table}.{from} renamed to {to} (data kept)'), { table: c.entityDb, from: c.from, to: c.to })
    case 'change_field_type': return fill(t('change.fieldType', '{table}.{db} type {from} → {to}'), { table: c.entityDb, db: c.dbName, from: c.from, to: c.to })
  }
}
