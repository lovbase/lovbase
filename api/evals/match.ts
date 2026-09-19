import { isDestructive, type Change } from '@lovbase/core/diff'
import type { IR } from '@lovbase/core/ir'
import type { Expect, Matcher } from './types'

/** Recursive partial comparison: every key the matcher states must be equal on the change. */
function matches(change: unknown, matcher: unknown): boolean {
  if (matcher === null || typeof matcher !== 'object') return change === matcher
  if (Array.isArray(matcher)) {
    if (!Array.isArray(change) || change.length !== matcher.length) return false
    return matcher.every((m, i) => matches(change[i], m))
  }
  if (change === null || typeof change !== 'object') return false
  return Object.entries(matcher as Record<string, unknown>)
    .every(([k, v]) => matches((change as Record<string, unknown>)[k], v))
}

const describe = (c: Change) => {
  switch (c.kind) {
    case 'create_entity': return `create_entity ${c.entity.dbName}(${c.entity.fields.map((f) => f.dbName).join(',')})`
    case 'drop_entity': return `drop_entity ${c.dbName}`
    case 'rename_entity': return `rename_entity ${c.from} → ${c.to}`
    case 'add_field': return `add_field ${c.entityDb}.${c.field.dbName}:${c.field.type}`
    case 'drop_field': return `drop_field ${c.entityDb}.${c.dbName}`
    case 'rename_field': return `rename_field ${c.entityDb}.${c.from} → ${c.to}`
    case 'change_field_type': return `change_field_type ${c.entityDb}.${c.dbName} ${c.from} → ${c.to}`
  }
}

const describeMatcher = (m: Matcher) =>
  `${m.kind}(${Object.entries(m).filter(([k]) => k !== 'kind').map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')})`

// Keyed by entity id, never by dbName: a table rename changes the dbName, and mistaking that for
// a lost column is exactly the false positive this whole suite exists to rule out.
const idsOf = (ir: IR) => [
  ...ir.entities.map((e) => `entity ${e.id}`),
  ...ir.entities.flatMap((e) => e.fields.map((f) => `field ${e.id}/${f.id}`)),
]

/**
 * Run one case's expectations against the real diff. Returns the reasons it failed, empty if it passed.
 *
 * The two safety defaults are derived rather than declared: a case only tolerates destructive changes
 * or disappearing ids when it explicitly expects them. That keeps the common case terse and makes
 * "the model quietly dropped a column" impossible to pass by omission.
 */
export function evaluate(given: IR, produced: IR, changes: Change[], expect: Expect): string[] {
  const failures: string[] = []
  const wanted = expect.changes ?? []
  const expectsDestructive = wanted.some((m) => isDestructive({ kind: m.kind } as Change))
  const expectsDrop = wanted.some((m) => m.kind === 'drop_entity' || m.kind === 'drop_field')

  const unmatched = [...changes]
  for (const m of wanted) {
    const i = unmatched.findIndex((c) => matches(c, m))
    if (i === -1) failures.push(`missing ${describeMatcher(m)}`)
    else unmatched.splice(i, 1)
  }

  if ((expect.exact ?? true) && unmatched.length)
    failures.push(`unexpected: ${unmatched.map(describe).join(', ')}`)

  if (expect.noDestructive ?? !expectsDestructive) {
    const bad = changes.filter(isDestructive)
    if (bad.length) failures.push(`destructive: ${bad.map(describe).join(', ')}`)
  }

  if (expect.preservesIds ?? !expectsDrop) {
    const before = new Set(idsOf(given))
    for (const id of before) if (!idsOf(produced).includes(id)) failures.push(`lost ${id}`)
  }

  const extra = expect.check?.(produced, changes)
  if (extra) failures.push(extra)

  return failures
}

export { describe as describeChange }
