import { schema, sql } from '@/lib/lovbase'
import { actionStatements, readStatements, type HelpdeskClient, type HelpdeskData } from '@lovbase/core/helpdesk'

// Reads and writes go through the workspace SQL API, one statement at a time. The statements
// themselves live in the domain module, next to the rules they rely on; the database triggers
// derive SLA targets, response and solved stamps and status moves from what is written here.
const read = <T>(table: keyof typeof readStatements) =>
  sql<T>(readStatements[table].sql, readStatements[table].params)

export const helpdeskClient: HelpdeskClient = {
  async read() {
    const [info, customers, agents, sla_policies, tickets, messages] = await Promise.all([
      schema(),
      read<HelpdeskData['customers'][number]>('customers'),
      read<HelpdeskData['agents'][number]>('agents'),
      read<HelpdeskData['sla_policies'][number]>('sla_policies'),
      read<HelpdeskData['tickets'][number]>('tickets'),
      read<HelpdeskData['messages'][number]>('messages'),
    ])
    return { readOnly: info.readOnly, customers, agents, sla_policies, tickets, messages }
  },
  async run(action) {
    for (const statement of actionStatements(action)) {
      const rows = await sql(statement.sql, statement.params)
      if (statement.expectRow && !rows.length) throw new Error('record_unavailable')
    }
  },
}
