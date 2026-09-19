import type { Field, IR } from './ir'
import { DB_NAME_RE } from './ir'
import type { Change } from './diff'

// ── Whitelist DDL generator. Every Change kind maps to hand-written SQL. ──
// LLM output NEVER reaches this layer as SQL — only as validated Change objects.

export const APP_SCHEMA = 'app_main'

function qi(name: string): string {
  if (!DB_NAME_RE.test(name)) throw new Error(`illegal identifier: ${name}`)
  return `"${name}"`
}
const qt = (table: string) => `${qi(APP_SCHEMA)}.${qi(table)}`

function columnType(f: Field, ir: IR): string {
  switch (f.type) {
    case 'text': return 'text'
    case 'number': return 'numeric'
    case 'boolean': return 'boolean'
    case 'date': return 'timestamptz'
    case 'select': return 'text'
    case 'link': {
      const target = ir.entities.find((e) => e.id === f.linkTo)
      if (!target) throw new Error(`link target missing for ${f.dbName}`)
      return `uuid REFERENCES ${qt(target.dbName)}(id)`
    }
  }
}

function columnDef(f: Field, ir: IR): string {
  // New columns are always nullable: adding NOT NULL to a live table is destructive.
  return `${qi(f.dbName)} ${columnType(f, ir)}`
}

/** next IR is needed to resolve link targets and column defs. */
export function changeToSQL(c: Change, next: IR): string[] {
  switch (c.kind) {
    case 'create_entity': {
      const cols = c.entity.fields.map((f) => columnDef(f, next))
      return [
        `CREATE TABLE ${qt(c.entity.dbName)} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()${cols.length ? ',\n  ' + cols.join(',\n  ') : ''}
)`,
      ]
    }
    case 'rename_entity':
      return [`ALTER TABLE ${qt(c.from)} RENAME TO ${qi(c.to)}`]
    case 'add_field': {
      const e = next.entities.find((x) => x.dbName === c.entityDb)
      if (!e) throw new Error(`entity ${c.entityDb} missing`)
      return [`ALTER TABLE ${qt(c.entityDb)} ADD COLUMN ${columnDef(c.field, next)}`]
    }
    case 'rename_field':
      return [`ALTER TABLE ${qt(c.entityDb)} RENAME COLUMN ${qi(c.from)} TO ${qi(c.to)}`]
    // ── destructive: only reachable after explicit human confirmation ──
    case 'drop_field':
      return [`ALTER TABLE ${qt(c.entityDb)} DROP COLUMN ${qi(c.dbName)}`]
    case 'drop_entity':
      return [`DROP TABLE ${qt(c.dbName)} CASCADE`]
    case 'change_field_type': {
      const e = next.entities.find((x) => x.dbName === c.entityDb)
      const f = e?.fields.find((x) => x.id === c.fieldId)
      if (!e || !f) throw new Error(`field for type change missing`)
      const t = columnType(f, next).split(' ')[0]
      return [`ALTER TABLE ${qt(c.entityDb)} ALTER COLUMN ${qi(c.dbName)} TYPE ${t} USING ${qi(c.dbName)}::text::${t}`]
    }
  }
}

/** Full DDL preview for the Code tab. */
export function irToDDL(ir: IR): string {
  const stmts: string[] = []
  for (const e of ir.entities)
    stmts.push(...changeToSQL({ kind: 'create_entity', entity: e }, ir))
  return stmts.map((s) => s + ';').join('\n\n')
}
