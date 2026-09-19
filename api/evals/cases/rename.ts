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
    when: '把客户表的"名称"改成"公司全称"',
    expect: { changes: [{ kind: 'rename_field', entityDb: 'customers', from: 'name' }] },
  },
  {
    name: 'rename a table',
    category: 'rename',
    given: crm,
    when: '把"客户"这张表改叫"公司"',
    expect: { changes: [{ kind: 'rename_entity', from: 'customers' }] },
  },
  {
    name: 'rename a column on the linked side',
    category: 'rename',
    given: crm,
    when: '联系人的"电话"字段改名叫"手机号"',
    expect: { changes: [{ kind: 'rename_field', entityDb: 'contacts', from: 'phone' }] },
  },
  {
    name: 'display-name-only change must not touch the column',
    category: 'rename',
    given: crm,
    when: '客户表里"负责人"这个标签改成"跟进人",数据库字段名别动',
    // Nothing physical changes, so the correct diff is empty. The IR still has to carry the new
    // label — see the `ir-only` case for the bug that makes it disappear.
    expect: { changes: [] },
  },
]
