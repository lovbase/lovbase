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
    when: '给客户加一个行业字段,只能填制造、零售、教育、其他',
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
    when: '客户表加一个字段,记录这个客户的主要联系人是谁',
    expect: {
      changes: [{ kind: 'add_field', entityDb: 'customers', field: { type: 'link', linkTo: 'e_contacts' } }],
    },
  },
  {
    name: 'yes/no becomes boolean',
    category: 'modeling-judgment',
    given: crm,
    when: '加个字段标记这个客户是不是重点客户',
    expect: { changes: [{ kind: 'add_field', entityDb: 'customers', field: { type: 'boolean' } }] },
  },
  {
    name: 'money is a number',
    category: 'modeling-judgment',
    given: inventory,
    when: '商品加一个采购单价',
    expect: { changes: [{ kind: 'add_field', entityDb: 'products', field: { type: 'number' } }] },
  },
]
