import type { IR } from '@lovbase/core/ir'

// Fixtures use readable ids on purpose (`f_cust_name` rather than `f_mtk4ivd701`): when a case
// fails, the reason reads "lost field customers.f_cust_name" instead of a timestamp hash.

export const emptyWorkspace: IR = { version: 1, appName: 'Untitled', entities: [] }

/** A small CRM, the shape most first prompts converge on. */
export const crm: IR = {
  version: 1,
  appName: '客户管理',
  entities: [
    {
      id: 'e_customers', name: '客户', dbName: 'customers',
      fields: [
        { id: 'f_cust_name', name: '名称', dbName: 'name', type: 'text', required: true },
        { id: 'f_cust_status', name: '状态', dbName: 'status', type: 'select', required: false, options: ['潜在', '跟进中', '已成交'] },
        { id: 'f_cust_owner', name: '负责人', dbName: 'owner', type: 'text', required: false },
      ],
    },
    {
      id: 'e_contacts', name: '联系人', dbName: 'contacts',
      fields: [
        { id: 'f_ct_name', name: '姓名', dbName: 'full_name', type: 'text', required: true },
        { id: 'f_ct_phone', name: '电话', dbName: 'phone', type: 'text', required: false },
        { id: 'f_ct_cust', name: '客户', dbName: 'customer', type: 'link', required: false, linkTo: 'e_customers' },
      ],
    },
  ],
}

/** Single table, no links — for cases where a second entity would only add noise. */
export const inventory: IR = {
  version: 1,
  appName: '库存台账',
  entities: [
    {
      id: 'e_products', name: '商品', dbName: 'products',
      fields: [
        { id: 'f_pr_name', name: '名称', dbName: 'name', type: 'text', required: true },
        { id: 'f_pr_stock', name: '当前库存', dbName: 'stock', type: 'number', required: false },
      ],
    },
  ],
}
