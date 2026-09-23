import { describe, expect, test } from 'bun:test'
import { diffIR, irEquals, isDestructive } from '../src/diff'
import { changeToSQL } from '../src/ddl'
import type { IR } from '../src/ir'

const base: IR = {
  version: 1,
  appName: 'crm',
  entities: [
    {
      id: 'e_1', name: 'Customer', dbName: 'customers',
      fields: [
        { id: 'f_1', name: 'Full name', dbName: 'name', type: 'text', required: true },
        { id: 'f_2', name: 'Phone', dbName: 'phone', type: 'text', required: false },
      ],
    },
  ],
}
const clone = (ir: IR): IR => JSON.parse(JSON.stringify(ir))

describe('diffIR — the reason stable ids exist', () => {
  test('rename entity is RENAME, never drop+create', () => {
    const next = clone(base)
    next.entities[0].name = 'Customer profile'
    next.entities[0].dbName = 'customer_profiles'
    const changes = diffIR(base, next)
    expect(changes).toEqual([
      { kind: 'rename_entity', entityId: 'e_1', from: 'customers', to: 'customer_profiles' },
    ])
    expect(changes.some(isDestructive)).toBe(false)
    expect(changeToSQL(changes[0], next)).toEqual([
      'ALTER TABLE "app_main"."customers" RENAME TO "customer_profiles"',
    ])
  })

  test('rename field is RENAME COLUMN', () => {
    const next = clone(base)
    next.entities[0].fields[1] = { ...next.entities[0].fields[1], name: 'Contact', dbName: 'contact' }
    const changes = diffIR(base, next)
    expect(changes).toEqual([
      { kind: 'rename_field', entityDb: 'customers', fieldId: 'f_2', from: 'phone', to: 'contact' },
    ])
  })

  test('add field is additive, nullable', () => {
    const next = clone(base)
    next.entities[0].fields.push({ id: 'f_3', name: 'Email', dbName: 'email', type: 'text', required: false })
    const changes = diffIR(base, next)
    expect(changes[0].kind).toBe('add_field')
    expect(changes.some(isDestructive)).toBe(false)
    expect(changeToSQL(changes[0], next)[0]).toBe(
      'ALTER TABLE "app_main"."customers" ADD COLUMN "email" text',
    )
  })

  test('removed field is destructive and requires confirmation', () => {
    const next = clone(base)
    next.entities[0].fields = next.entities[0].fields.slice(0, 1)
    const changes = diffIR(base, next)
    expect(changes).toEqual([
      { kind: 'drop_field', entityDb: 'customers', fieldId: 'f_2', dbName: 'phone', name: 'Phone' },
    ])
    expect(changes.every(isDestructive)).toBe(true)
  })

  test('type change is destructive', () => {
    const next = clone(base)
    next.entities[0].fields[1] = { ...next.entities[0].fields[1], type: 'number' }
    expect(diffIR(base, next).every(isDestructive)).toBe(true)
  })

  test('new entity with link generates FK', () => {
    const next = clone(base)
    next.entities.push({
      id: 'e_2', name: 'Order', dbName: 'orders',
      fields: [
        { id: 'f_9', name: 'Customer', dbName: 'customer', type: 'link', linkTo: 'e_1', required: false },
        { id: 'f_10', name: 'Amount', dbName: 'amount', type: 'number', required: false },
      ],
    })
    const changes = diffIR(base, next)
    expect(changes[0].kind).toBe('create_entity')
    const sql = changeToSQL(changes[0], next)[0]
    expect(sql).toContain('REFERENCES "app_main"."customers"(id)')
  })

  test('illegal identifier is rejected at the DDL gate', () => {
    const next = clone(base)
    next.entities[0].dbName = 'x"; DROP TABLE users; --' as any
    const changes = diffIR(base, next)
    expect(() => changeToSQL(changes[0], next)).toThrow(/illegal identifier/)
  })
})

describe('irEquals — what diffIR deliberately does not see', () => {
  const base: IR = {
    version: 1, appName: 'CRM',
    entities: [{
      id: 'e1', name: 'Customer', dbName: 'customers',
      fields: [
        { id: 'f1', name: 'Name', dbName: 'name', type: 'text', required: true },
        { id: 'f2', name: 'Status', dbName: 'status', type: 'select', required: false, options: ['Lead', 'Won'] },
      ],
    }],
  }
  const clone = (): IR => JSON.parse(JSON.stringify(base))

  test('an unchanged IR is equal', () => {
    expect(irEquals(base, clone())).toBe(true)
    expect(diffIR(base, clone())).toEqual([])
  })

  // Each of these produces an empty diff — correctly, since Postgres needs no DDL — which is
  // exactly why irEquals has to catch them or the edit is thrown away.
  test('adding a select option is invisible to the differ but not to irEquals', () => {
    const next = clone()
    next.entities[0].fields[1].options!.push('Lost')
    expect(diffIR(base, next)).toEqual([])
    expect(irEquals(base, next)).toBe(false)
  })

  test('renaming only the display label', () => {
    const next = clone()
    next.entities[0].fields[0].name = 'Company name'
    expect(diffIR(base, next)).toEqual([])
    expect(irEquals(base, next)).toBe(false)
  })

  test('flipping required', () => {
    const next = clone()
    next.entities[0].fields[1].required = true
    expect(diffIR(base, next)).toEqual([])
    expect(irEquals(base, next)).toBe(false)
  })

  test('renaming the app', () => {
    const next = clone()
    next.appName = 'Sales system'
    expect(diffIR(base, next)).toEqual([])
    expect(irEquals(base, next)).toBe(false)
  })

  test('a real column rename is caught by both', () => {
    const next = clone()
    next.entities[0].fields[0].dbName = 'company_name'
    expect(diffIR(base, next)).toHaveLength(1)
    expect(irEquals(base, next)).toBe(false)
  })
})
