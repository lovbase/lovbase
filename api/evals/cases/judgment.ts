import type { Case } from '../types'
import { crm, inventory } from '../fixtures'

// ── Does the model model, or does it just transcribe? ──
// These are the cases that separate a useful modeller from an autocomplete: a fixed set of states
// is a `select`, a reference to another table is a `link`, a yes/no is a `boolean`. Getting these
// wrong produces a schema that technically works and is wrong to live with.
export const cases: Case[] = [
  {
    name: 'fixed set of values becomes select, not text',
    category: 'modeling-judgment',
    given: crm,
    when: 'Add an industry field to customers; the only allowed values are manufacturing, retail, education and other',
    expect: {
      changes: [{ kind: 'add_field', entityDb: 'customers', field: { type: 'select' } }],
      check: (ir) => {
        const f = ir.entities.find((e) => e.dbName === 'customers')!.fields.find((x) => x.id === '' || !['f_cust_name', 'f_cust_status', 'f_cust_owner'].includes(x.id))
        if (!f?.options?.length) return 'select has no options'
        return f.options.length === 4 ? null : `expected 4 options, got ${f.options.length}: ${f.options.join('/')}`
      },
    },
  },
  {
    name: 'a reference becomes a link, not a text column',
    category: 'modeling-judgment',
    given: crm,
    when: 'Add a field to the customers table that records who the primary contact for the customer is',
    expect: {
      changes: [{ kind: 'add_field', entityDb: 'customers', field: { type: 'link', linkTo: 'e_contacts' } }],
    },
  },
  {
    name: 'yes/no becomes boolean',
    category: 'modeling-judgment',
    given: crm,
    when: 'Add a field marking whether the customer is a key account',
    expect: { changes: [{ kind: 'add_field', entityDb: 'customers', field: { type: 'boolean' } }] },
  },
  {
    name: 'money is a number',
    category: 'modeling-judgment',
    given: inventory,
    when: 'Add a purchase unit price to products',
    expect: { changes: [{ kind: 'add_field', entityDb: 'products', field: { type: 'number' } }] },
  },
]
