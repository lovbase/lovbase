import type { Case } from '../types'
import { crm, emptyWorkspace } from '../fixtures'

// The baseline. A model that cannot pass these cannot be used at all, so these double as a smoke test.
export const cases: Case[] = [
  {
    name: 'add one column',
    category: 'add',
    given: crm,
    when: '给客户加一个手机号',
    expect: { changes: [{ kind: 'add_field', entityDb: 'customers', field: { type: 'text' } }] },
  },
  {
    name: 'add a table that links to an existing one',
    category: 'add',
    given: crm,
    when: '再加一张跟进记录表,要有时间、方式、摘要,并且关联到客户',
    expect: {
      changes: [{ kind: 'create_entity' }],
      check: (ir) => {
        const e = ir.entities.find((x) => !['customers', 'contacts'].includes(x.dbName))
        if (!e) return 'no new entity'
        const link = e.fields.find((f) => f.type === 'link')
        if (!link) return `${e.dbName} has no link field — the relation was modelled as plain text`
        if (link.linkTo !== 'e_customers') return `${e.dbName}.${link.dbName} links to ${link.linkTo}, not the customers entity`
        if (!e.fields.some((f) => f.type === 'date')) return `${e.dbName} has no date field for 时间`
        return null
      },
    },
  },
  {
    name: 'build from nothing',
    category: 'add',
    given: emptyWorkspace,
    when: '做一个简单的待办清单:任务标题、是否完成、截止日期',
    expect: {
      changes: [{ kind: 'create_entity' }],
      check: (ir) => {
        const e = ir.entities[0]
        if (ir.entities.length !== 1) return `expected exactly one table, got ${ir.entities.length}`
        const types = e.fields.map((f) => f.type)
        if (!types.includes('boolean')) return `"是否完成" was modelled as ${types.join('/')}, not boolean`
        if (!types.includes('date')) return `"截止日期" was modelled as ${types.join('/')}, not date`
        return null
      },
    },
  },
]
