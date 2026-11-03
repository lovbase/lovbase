import { schema, sql } from '@/lib/lovbase'
import {
  errorCode,
  readStatements,
  recruitingTables,
  statementFor,
  validate,
  type RecruitingClient,
  type RecruitingData,
} from '@lovbase/core/recruiting'

/**
 * Reads every table and runs each action as one SQL statement through the workspace SQL API.
 * The database triggers keep the history, the seats and the job status; nothing here repeats them.
 */
export const recruitingClient: RecruitingClient = {
  async read() {
    const [info, ...tables] = await Promise.all([schema(), ...recruitingTables.map((table) => sql(readStatements[table]))])
    const data: Record<string, unknown> = { readOnly: info.readOnly }
    recruitingTables.forEach((table, i) => (data[table] = tables[i]))
    return data as RecruitingData
  },
  async run(action) {
    validate(action)
    const statement = statementFor(action)
    let rows: unknown[]
    try {
      rows = await sql(statement.sql, statement.params)
    } catch (error) {
      const code = errorCode(error instanceof Error ? error.message : '')
      // The same id again means an earlier attempt landed and only its response was lost.
      if (code === 'duplicate_id') return
      throw new Error(code, { cause: error })
    }
    if (statement.one && rows.length !== 1) throw new Error('record_unavailable')
  },
}
