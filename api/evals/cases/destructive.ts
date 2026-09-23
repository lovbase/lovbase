import type { Case } from '../types'
import { crm, inventory } from '../fixtures'

// Destructive changes are allowed — they just have to be *recognised*, because that is what routes
// them to the confirmation step instead of straight to Postgres.
export const cases: Case[] = [
  {
    name: 'loosening a select to free text is a type change',
    category: 'type-change',
    given: crm,
    when: 'Customer status should be free text now, no fixed options',
    expect: {
      changes: [{ kind: 'change_field_type', entityDb: 'customers', fieldId: 'f_cust_status', from: 'select', to: 'text' }],
    },
  },
  {
    name: 'an explicit delete is a drop, not a silent no-op',
    category: 'type-change',
    given: inventory,
    when: 'Delete the stock field from the products table, we do not need it',
    expect: {
      changes: [{ kind: 'drop_field', entityDb: 'products', fieldId: 'f_pr_stock' }],
    },
  },
]
