import type { Case } from '../types'
import { crm } from '../fixtures'

// Iron rule 3: never touch what the user did not ask about. `exact: true` (the default) is what
// enforces it — a model that helpfully "improves" two other columns fails here.
export const cases: Case[] = [
  {
    name: 'one request changes exactly one thing',
    category: 'preserve',
    given: crm,
    when: 'Add an email to contacts',
    expect: { changes: [{ kind: 'add_field', entityDb: 'contacts', field: { type: 'text' } }] },
  },
  {
    name: 'mentioning other tables does not license editing them',
    category: 'preserve',
    given: crm,
    when: 'Our contacts hang off customers; now add a job title field to contacts',
    expect: { changes: [{ kind: 'add_field', entityDb: 'contacts', field: { type: 'text' } }] },
  },
  {
    name: 'options-only change survives the pipeline',
    category: 'preserve',
    given: crm,
    when: 'Add a "Lost" option to customer status',
    // No column changes — `select` is plain text in Postgres — so the diff is empty and the whole
    // point is that the new option still has to reach the stored IR.
    expect: {
      changes: [],
      check: (ir) => {
        const f = ir.entities.find((e) => e.dbName === 'customers')!.fields.find((x) => x.id === 'f_cust_status')
        return f?.options?.includes('Lost') ? null : `options are ${f?.options?.join('/')} — the new one was dropped`
      },
    },
  },
]
