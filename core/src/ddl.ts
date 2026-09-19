import type { Field, IR } from './ir'
import { DB_NAME_RE } from './ir'
import type { Change } from './diff'

// ── Whitelist DDL generator. Every Change kind maps to hand-written SQL. ──
// LLM output NEVER reaches this layer as SQL — only as validated Change objects.
// Every project lives in its own Postgres schema; the schema name is passed in.

export const APP_SCHEMA = 'app_main'

export function qi(name: string): string {
  if (!DB_NAME_RE.test(name)) throw new Error(`illegal identifier: ${name}`)
  return `"${name}"`
}
const qt = (schema: string, table: string) => `${qi(schema)}.${qi(table)}`

function columnType(f: Field, ir: IR, schema: string): string {
  switch (f.type) {
    case 'text': return 'text'
    case 'number': return 'numeric'
    case 'boolean': return 'boolean'
    case 'date': return 'timestamptz'
    case 'select': return 'text'
    case 'link': {
      const target = ir.entities.find((e) => e.id === f.linkTo)
      if (!target) throw new Error(`link target missing for ${f.dbName}`)
      return `uuid REFERENCES ${qt(schema, target.dbName)}(id)`
    }
  }
}

function columnDef(f: Field, ir: IR, schema: string): string {
  // New columns are always nullable: adding NOT NULL to a live table is destructive.
  return `${qi(f.dbName)} ${columnType(f, ir, schema)}`
}

/** next IR is needed to resolve link targets and column defs. */
export function changeToSQL(c: Change, next: IR, schema: string = APP_SCHEMA): string[] {
  switch (c.kind) {
    case 'create_entity': {
      const cols = c.entity.fields.map((f) => columnDef(f, next, schema))
      return [
        `CREATE TABLE ${qt(schema, c.entity.dbName)} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()${cols.length ? ',\n  ' + cols.join(',\n  ') : ''}
)`,
      ]
    }
    case 'rename_entity':
      return [`ALTER TABLE ${qt(schema, c.from)} RENAME TO ${qi(c.to)}`]
    case 'add_field': {
      const e = next.entities.find((x) => x.dbName === c.entityDb)
      if (!e) throw new Error(`entity ${c.entityDb} missing`)
      return [`ALTER TABLE ${qt(schema, c.entityDb)} ADD COLUMN ${columnDef(c.field, next, schema)}`]
    }
    case 'rename_field':
      return [`ALTER TABLE ${qt(schema, c.entityDb)} RENAME COLUMN ${qi(c.from)} TO ${qi(c.to)}`]
    // ── destructive: only reachable after explicit human confirmation ──
    case 'drop_field':
      return [`ALTER TABLE ${qt(schema, c.entityDb)} DROP COLUMN ${qi(c.dbName)}`]
    case 'drop_entity':
      return [`DROP TABLE ${qt(schema, c.dbName)} CASCADE`]
    case 'change_field_type': {
      const e = next.entities.find((x) => x.dbName === c.entityDb)
      const f = e?.fields.find((x) => x.id === c.fieldId)
      if (!e || !f) throw new Error(`field for type change missing`)
      const t = columnType(f, next, schema).split(' ')[0]
      return [`ALTER TABLE ${qt(schema, c.entityDb)} ALTER COLUMN ${qi(c.dbName)} TYPE ${t} USING ${qi(c.dbName)}::text::${t}`]
    }
  }
}

/** Full DDL preview for the Code tab. Tables are emitted in dependency order so the script is runnable. */
export function irToDDL(ir: IR, schema: string = APP_SCHEMA): string {
  const done = new Set<string>()
  const ordered: typeof ir.entities = []
  const visit = (e: (typeof ir.entities)[number]) => {
    if (done.has(e.id)) return
    done.add(e.id)
    for (const f of e.fields)
      if (f.type === 'link' && f.linkTo && f.linkTo !== e.id) {
        const t = ir.entities.find((x) => x.id === f.linkTo)
        if (t) visit(t)
      }
    ordered.push(e)
  }
  ir.entities.forEach(visit)
  const stmts = [`CREATE SCHEMA IF NOT EXISTS ${qi(schema)}`]
  for (const e of ordered) stmts.push(...changeToSQL({ kind: 'create_entity', entity: e }, ir, schema))
  return stmts.map((s) => s + ';').join('\n\n')
}
