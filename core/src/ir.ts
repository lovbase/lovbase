import { z } from 'zod'

// ── The IR is the product's real data model. Everything else derives from it. ──
// Stable ids (`id`) never change once assigned; names are just labels.
// `dbName` is the physical Postgres identifier (snake_case ascii).

export const DB_NAME_RE = /^[a-z][a-z0-9_]{0,58}$/

export const FieldType = z.enum(['text', 'number', 'boolean', 'date', 'select', 'link'])
export type FieldType = z.infer<typeof FieldType>

export const Field = z.object({
  id: z.string().default(''), // '' = new, server assigns
  name: z.string().min(1), // display name, any language
  dbName: z.string().regex(DB_NAME_RE),
  type: FieldType,
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(), // for select
  linkTo: z.string().optional(), // entity id, for link
})
export type Field = z.infer<typeof Field>

export const Entity = z.object({
  id: z.string().default(''),
  name: z.string().min(1),
  dbName: z.string().regex(DB_NAME_RE),
  fields: z.array(Field).min(1),
})
export type Entity = z.infer<typeof Entity>

export const IR = z.object({
  version: z.literal(1).default(1),
  appName: z.string().default('Untitled'),
  entities: z.array(Entity),
})
export type IR = z.infer<typeof IR>

export const emptyIR = (): IR => ({ version: 1, appName: 'Untitled', entities: [] })

let n = 0
export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${(n++ % 1296).toString(36).padStart(2, '0')}`

/** Assign ids to new entities/fields; existing ids are preserved verbatim. */
export function assignIds(ir: IR): IR {
  return {
    ...ir,
    entities: ir.entities.map((e) => ({
      ...e,
      id: e.id || newId('e'),
      fields: e.fields.map((f) => ({ ...f, id: f.id || newId('f') })),
    })),
  }
}

/** Reject IRs the LLM got structurally wrong before they reach the differ. */
export function validateIR(ir: IR): string[] {
  const errors: string[] = []
  const entityIds = new Set<string>()
  const dbNames = new Set<string>()
  for (const e of ir.entities) {
    if (e.id && entityIds.has(e.id)) errors.push(`duplicate entity id ${e.id}`)
    if (e.id) entityIds.add(e.id)
    if (dbNames.has(e.dbName)) errors.push(`duplicate table name ${e.dbName}`)
    dbNames.add(e.dbName)
    const fieldDb = new Set<string>()
    for (const f of e.fields) {
      if (fieldDb.has(f.dbName)) errors.push(`duplicate column ${e.dbName}.${f.dbName}`)
      fieldDb.add(f.dbName)
      if (f.dbName === 'id' || f.dbName === 'created_at')
        errors.push(`${e.dbName}.${f.dbName} collides with a system column`)
      if (f.type === 'select' && !f.options?.length)
        errors.push(`${e.dbName}.${f.dbName} is select but has no options`)
      if (f.type === 'link' && !f.linkTo) errors.push(`${e.dbName}.${f.dbName} is link but has no linkTo`)
    }
  }
  for (const e of ir.entities)
    for (const f of e.fields)
      if (f.type === 'link' && f.linkTo && !ir.entities.some((x) => x.id === f.linkTo))
        errors.push(`${e.dbName}.${f.dbName} links to unknown entity ${f.linkTo}`)
  return errors
}
