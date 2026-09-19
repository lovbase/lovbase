import { createServerFn } from '@tanstack/react-start'
import { RolesService, RowsService, SqlError, SqlService, schemaFor, svc } from '@lovbase/api'
import { requireProject, sharedProject } from './_ctx'

// ── Row data (owner) ──

export const listRows = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; entityId: string }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    return (await svc(RowsService)).list(project.id, project.ir, data.entityId)
  })

export const insertRow = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; entityId: string; values: Record<string, unknown> }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    return (await svc(RowsService)).insert(project.id, project.ir, data.entityId, data.values)
  })

export const deleteRow = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; entityId: string; rowId: string }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    await (await svc(RowsService)).remove(project.id, project.ir, data.entityId, data.rowId)
    return { ok: true }
  })

// ── Shared app (public, token-scoped: read + add rows, never schema) ──

export const getSharedState = createServerFn()
  .validator((d: { token: string }) => d)
  .handler(async ({ data }) => {
    const p = await sharedProject(data.token)
    return { name: p.ir.appName, ir: p.ir }
  })

export const listSharedRows = createServerFn({ method: 'POST' })
  .validator((d: { token: string; entityId: string }) => d)
  .handler(async ({ data }) => {
    const p = await sharedProject(data.token)
    return (await svc(RowsService)).list(p.id, p.ir, data.entityId)
  })

export const insertSharedRow = createServerFn({ method: 'POST' })
  .validator((d: { token: string; entityId: string; values: Record<string, unknown> }) => d)
  .handler(async ({ data }) => {
    const p = await sharedProject(data.token)
    return (await svc(RowsService)).insert(p.id, p.ir, data.entityId, data.values)
  })

// ── Database client (owner): catalog, ad-hoc SQL, batched edits — all as the workspace role ──

export const dbTables = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    const schema = schemaFor(project.id)
    return { schema, tables: await (await svc(SqlService)).introspect(schema) }
  })

export const dbQuery = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; sql: string; params?: unknown[] }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    const role = await (await svc(RolesService)).ensureWorkspaceRole(project.id)
    const t0 = Date.now()
    try {
      const r = await (await svc(SqlService)).run(role, schemaFor(project.id), data.sql, data.params ?? [])
      return { ...r, rows: r.rows as any[], ms: Date.now() - t0, error: null as string | null }
    } catch (err) {
      if (err instanceof SqlError)
        return { rows: [], rowCount: 0, fields: [], truncated: false, kind: 'read' as const, ms: Date.now() - t0, error: err.message }
      throw err
    }
  })

export const dbCommit = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; statements: { sql: string; params?: unknown[] }[] }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    const role = await (await svc(RolesService)).ensureWorkspaceRole(project.id)
    try {
      return { ...(await (await svc(SqlService)).runBatch(role, schemaFor(project.id), data.statements)), error: null as string | null }
    } catch (err) {
      if (err instanceof SqlError) return { affected: 0, error: err.message }
      throw err
    }
  })
