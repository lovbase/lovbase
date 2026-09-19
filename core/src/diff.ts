import type { Entity, Field, IR } from './ir'

// ── Diff two IRs BY STABLE ID. Never by name — names are labels. ──
// A rename is a rename precisely because the id survived.

export type Change =
  | { kind: 'create_entity'; entity: Entity }
  | { kind: 'drop_entity'; entityId: string; dbName: string; name: string }
  | { kind: 'rename_entity'; entityId: string; from: string; to: string }
  | { kind: 'add_field'; entityDb: string; field: Field }
  | { kind: 'drop_field'; entityDb: string; fieldId: string; dbName: string; name: string }
  | { kind: 'rename_field'; entityDb: string; fieldId: string; from: string; to: string }
  | { kind: 'change_field_type'; entityDb: string; fieldId: string; dbName: string; from: string; to: string }

/** Destructive changes are the ONLY ones allowed to touch existing data. They require human confirmation. */
export const isDestructive = (c: Change) =>
  c.kind === 'drop_entity' || c.kind === 'drop_field' || c.kind === 'change_field_type'

/**
 * Whole-IR equality, including everything `diffIR` ignores.
 *
 * `diffIR` only reports what Postgres has to be told about: table and column names, and column
 * types. A select's options, a display label and `required` live in the IR alone — editing one
 * produces no DDL and therefore no `Change`. That is correct, but it means an empty diff does not
 * mean "nothing changed", and treating it that way silently discards the edit.
 */
export function irEquals(a: IR, b: IR): boolean {
  if (a.appName !== b.appName || a.entities.length !== b.entities.length) return false
  const byId = new Map(b.entities.map((e) => [e.id, e]))
  return a.entities.every((e) => {
    const o = byId.get(e.id)
    if (!o || o.name !== e.name || o.dbName !== e.dbName || o.fields.length !== e.fields.length) return false
    const fields = new Map(o.fields.map((f) => [f.id, f]))
    return e.fields.every((f) => {
      const g = fields.get(f.id)
      return (
        !!g && g.name === f.name && g.dbName === f.dbName && g.type === f.type &&
        !!g.required === !!f.required && g.linkTo === f.linkTo &&
        (g.options ?? []).join('\u0000') === (f.options ?? []).join('\u0000')
      )
    })
  })
}

export function diffIR(prev: IR, next: IR): Change[] {
  const changes: Change[] = []
  const prevById = new Map(prev.entities.map((e) => [e.id, e]))
  const nextById = new Map(next.entities.map((e) => [e.id, e]))

  for (const e of next.entities) {
    const old = prevById.get(e.id)
    if (!old) {
      changes.push({ kind: 'create_entity', entity: e })
      continue
    }
    if (old.dbName !== e.dbName)
      changes.push({ kind: 'rename_entity', entityId: e.id, from: old.dbName, to: e.dbName })

    const oldF = new Map(old.fields.map((f) => [f.id, f]))
    for (const f of e.fields) {
      const of_ = oldF.get(f.id)
      if (!of_) {
        changes.push({ kind: 'add_field', entityDb: e.dbName, field: f })
        continue
      }
      if (of_.dbName !== f.dbName)
        changes.push({ kind: 'rename_field', entityDb: e.dbName, fieldId: f.id, from: of_.dbName, to: f.dbName })
      if (of_.type !== f.type)
        changes.push({
          kind: 'change_field_type', entityDb: e.dbName, fieldId: f.id,
          dbName: f.dbName, from: of_.type, to: f.type,
        })
    }
    for (const of_ of old.fields)
      if (!e.fields.some((f) => f.id === of_.id))
        changes.push({ kind: 'drop_field', entityDb: e.dbName, fieldId: of_.id, dbName: of_.dbName, name: of_.name })
  }

  for (const old of prev.entities)
    if (!nextById.has(old.id))
      changes.push({ kind: 'drop_entity', entityId: old.id, dbName: old.dbName, name: old.name })

  return changes
}
