import { isDestructive, type Change } from '@lovbase/core/diff'

export function ChangeList({ changes, plain = false }: { changes: Change[]; plain?: boolean }) {
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
            <span className="text-fg-mid">{describeChange(c)}</span>
          </li>
        )
      })}
    </ul>
  )
}

function describeChange(c: Change): string {
  switch (c.kind) {
    case 'create_entity': return `新建表 ${c.entity.name}(${c.entity.dbName}),${c.entity.fields.length} 个字段`
    case 'drop_entity': return `删除表 ${c.name}(${c.dbName})及其全部数据`
    case 'rename_entity': return `表 ${c.from} 改名为 ${c.to}(数据保留)`
    case 'add_field': return `${c.entityDb} 加字段 ${c.field.name}(${c.field.dbName})`
    case 'drop_field': return `${c.entityDb} 删字段 ${c.name}(${c.dbName})及其数据`
    case 'rename_field': return `${c.entityDb}.${c.from} 改名为 ${c.to}(数据保留)`
    case 'change_field_type': return `${c.entityDb}.${c.dbName} 类型 ${c.from} → ${c.to}`
  }
}
