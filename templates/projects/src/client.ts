import { sql } from '@/lib/lovbase'
import {
  normalizeRow,
  projectsTables,
  readStatements,
  READ_ONLY_PROBE,
  statement,
  type ProjectsClient,
  type ProjectsData,
} from '@lovbase/core/projects'

/**
 * Reads every table and writes one statement per action through the workspace SQL API. Task
 * numbers, completion times and history are written by database triggers, not here.
 */
export const projectsClient: ProjectsClient = {
  async read() {
    const [probe, ...tables] = await Promise.all([
      sql<{ read_only: boolean }>(READ_ONLY_PROBE),
      ...projectsTables.map((table) => sql(readStatements[table])),
    ])
    return {
      readOnly: !!probe[0]?.read_only,
      ...Object.fromEntries(projectsTables.map((table, i) => [table, tables[i].map(normalizeRow)])),
    } as ProjectsData
  },
  async run(action) {
    const { sql: text, params } = statement(action)
    await sql(text, params)
  },
}
