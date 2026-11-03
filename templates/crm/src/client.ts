import { schema, sql } from '@/lib/lovbase'
import { crmReads, crmStatement, type CrmClient, type CrmData } from '@lovbase/core/crm'

/**
 * One SELECT per table to read, exactly one statement per action to write. The statements live
 * in the domain module, so the API tests run the very same SQL through the real SQL path.
 */
export const crmClient: CrmClient = {
  async read() {
    const [info, ...tables] = await Promise.all([schema(), ...crmReads.map((read) => sql(read.sql))])
    const data: Record<string, unknown> = { readOnly: info.readOnly }
    crmReads.forEach((read, i) => {
      data[read.table] = tables[i]
    })
    return data as CrmData
  },
  async run(action) {
    const statement = crmStatement(action)
    const rows = await sql(statement.sql, statement.params)
    // Every write returns the id it touched: no row means the record changed under us.
    if (!rows.length) throw new Error('record_changed')
  },
}
