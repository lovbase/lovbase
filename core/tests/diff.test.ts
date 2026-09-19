import { describe, expect, test } from 'bun:test'
import { diffIR, isDestructive } from '../src/diff'
import { changeToSQL } from '../src/ddl'
import type { IR } from '../src/ir'

const base: IR = {
  version: 1,
  appName: 'crm',
  entities: [
    {
      id: 'e_1', name: '客户', dbName: 'customers',
      fields: [
        { id: 'f_1', name: '姓名', dbName: 'name', type: 'text', required: true },
        { id: 'f_2', name: '电话', dbName: 'phone', type: 'text', required: false },
      ],
    },
  ],
}
const clone = (ir: IR): IR => JSON.parse(JSON.stringify(ir))

describe('diffIR — the reason stable ids exist', () => {
  test('rename entity is RENAME, never drop+create', () => {
    const next = clone(base)
    next.entities[0].name = '客户档案'
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
    next.entities[0].fields[1] = { ...next.entities[0].fields[1], name: '联系方式', dbName: 'contact' }
    const changes = diffIR(base, next)
    expect(changes).toEqual([
      { kind: 'rename_field', entityDb: 'customers', fieldId: 'f_2', from: 'phone', to: 'contact' },
    ])
  })

  test('add field is additive, nullable', () => {
    const next = clone(base)
    next.entities[0].fields.push({ id: 'f_3', name: '邮箱', dbName: 'email', type: 'text', required: false })
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
      { kind: 'drop_field', entityDb: 'customers', fieldId: 'f_2', dbName: 'phone', name: '电话' },
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
      id: 'e_2', name: '订单', dbName: 'orders',
      fields: [
        { id: 'f_9', name: '客户', dbName: 'customer', type: 'link', linkTo: 'e_1', required: false },
        { id: 'f_10', name: '金额', dbName: 'amount', type: 'number', required: false },
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
