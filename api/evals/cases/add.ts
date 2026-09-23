import type { Case } from '../types'
import { crm, emptyWorkspace } from '../fixtures'

// The baseline. A model that cannot pass these cannot be used at all, so these double as a smoke test.
export const cases: Case[] = [
  {
    name: 'add one column',
    category: 'add',
    given: crm,
    when: 'Add a mobile number to customers',
    expect: { changes: [{ kind: 'add_field', entityDb: 'customers', field: { type: 'text' } }] },
  },
  {
    name: 'add a table that links to an existing one',
    category: 'add',
    given: crm,
    when: 'Add a follow-ups table with a time, a channel and a summary, linked to the customer',
    expect: {
      changes: [{ kind: 'create_entity' }],
      check: (ir) => {
        const e = ir.entities.find((x) => !['customers', 'contacts'].includes(x.dbName))
        if (!e) return 'no new entity'
        const link = e.fields.find((f) => f.type === 'link')
        if (!link) return `${e.dbName} has no link field — the relation was modelled as plain text`
        if (link.linkTo !== 'e_customers') return `${e.dbName}.${link.dbName} links to ${link.linkTo}, not the customers entity`
        if (!e.fields.some((f) => f.type === 'date')) return `${e.dbName} has no date field for the time`
        return null
      },
    },
  },
  {
    name: 'build from nothing',
    category: 'add',
    given: emptyWorkspace,
    when: 'Make a simple to-do list: task title, whether it is done, due date',
    expect: {
      changes: [{ kind: 'create_entity' }],
      check: (ir) => {
        const e = ir.entities[0]
        if (ir.entities.length !== 1) return `expected exactly one table, got ${ir.entities.length}`
        const types = e.fields.map((f) => f.type)
        if (!types.includes('boolean')) return `"whether it is done" was modelled as ${types.join('/')}, not boolean`
        if (!types.includes('date')) return `"due date" was modelled as ${types.join('/')}, not date`
        return null
      },
    },
  },
]
