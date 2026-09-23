import type { IR } from '@lovbase/core/ir'

// Fixtures use readable ids on purpose (`f_cust_name` rather than `f_mtk4ivd701`): when a case
// fails, the reason reads "lost field customers.f_cust_name" instead of a timestamp hash.

export const emptyWorkspace: IR = { version: 1, appName: 'Untitled', entities: [] }

/** A small CRM, the shape most first prompts converge on. */
export const crm: IR = {
  version: 1,
  appName: 'Customer Management',
  entities: [
    {
      id: 'e_customers', name: 'Customer', dbName: 'customers',
      fields: [
        { id: 'f_cust_name', name: 'Name', dbName: 'name', type: 'text', required: true },
        { id: 'f_cust_status', name: 'Status', dbName: 'status', type: 'select', required: false, options: ['Lead', 'In progress', 'Won'] },
        { id: 'f_cust_owner', name: 'Owner', dbName: 'owner', type: 'text', required: false },
      ],
    },
    {
      id: 'e_contacts', name: 'Contact', dbName: 'contacts',
      fields: [
        { id: 'f_ct_name', name: 'Full name', dbName: 'full_name', type: 'text', required: true },
        { id: 'f_ct_phone', name: 'Phone', dbName: 'phone', type: 'text', required: false },
        { id: 'f_ct_cust', name: 'Customer', dbName: 'customer', type: 'link', required: false, linkTo: 'e_customers' },
      ],
    },
  ],
}

/** Single table, no links — for cases where a second entity would only add noise. */
export const inventory: IR = {
  version: 1,
  appName: 'Inventory Ledger',
  entities: [
    {
      id: 'e_products', name: 'Product', dbName: 'products',
      fields: [
        { id: 'f_pr_name', name: 'Name', dbName: 'name', type: 'text', required: true },
        { id: 'f_pr_stock', name: 'Stock on hand', dbName: 'stock', type: 'number', required: false },
      ],
    },
  ],
}
