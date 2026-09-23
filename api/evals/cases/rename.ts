import type { Case } from '../types'
import { crm } from '../fixtures'

// ── The product's central claim: changing your mind must not cost you data. ──
// Every case here asserts the SHAPE of the change, never the model's naming taste: what matters is
// that the id survived and the diff came out as a RENAME. A model that drops and recreates the
// column produces drop_field + add_field, which these assertions catch and reject outright.
export const cases: Case[] = [
  {
    name: 'rename a column',
    category: 'rename',
    given: crm,
    when: 'Rename the "Name" column of the customers table to "Company full name"',
    expect: { changes: [{ kind: 'rename_field', entityDb: 'customers', from: 'name' }] },
  },
  {
    name: 'rename a table',
    category: 'rename',
    given: crm,
    when: 'Rename the "Customer" table to "Company"',
    expect: { changes: [{ kind: 'rename_entity', from: 'customers' }] },
  },
  {
    name: 'rename a column on the linked side',
    category: 'rename',
    given: crm,
    when: 'Rename the "Phone" field on contacts to "Mobile number"',
    expect: { changes: [{ kind: 'rename_field', entityDb: 'contacts', from: 'phone' }] },
  },
  {
    name: 'display-name-only change must not touch the column',
    category: 'rename',
    given: crm,
    when: 'In the customers table change the "Owner" label to "Account manager", but leave the database column name alone',
    // Nothing physical changes, so the correct diff is empty. The IR still has to carry the new
    // label — see the `ir-only` case for the bug that makes it disappear.
    expect: { changes: [] },
  },
]
