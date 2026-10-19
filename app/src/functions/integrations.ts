import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { SheetMapping, SheetSource } from '@lovbase/core/sheets'
import { ConnectionsService, SheetImportsService, svc } from '@lovbase/api'
import { requireUser, requireProject, requireApp } from './_ctx'

const project = z.object({ projectId: z.string().min(1) })
const app = project.extend({ appId: z.string().min(1) })
const record = project.extend({ id: z.string().min(1) })
export const getConnections = createServerFn({ method: 'POST' })
  .handler(async () => (await svc(ConnectionsService)).list(await requireUser()))
export const getProjectConnections = createServerFn({ method: 'POST' })
  .validator(project)
  .handler(async ({ data }) => (await svc(ConnectionsService)).projectState(await requireProject(data.projectId)))
export const connectGoogle = createServerFn({ method: 'POST' })
  .validator(z.object({ label: z.string().trim().min(1).max(100), projectId: z.string().min(1).optional() }))
  .handler(async ({ data }) => (await svc(ConnectionsService)).begin(await requireUser(), data.label, data.projectId))
export const disconnectGoogle = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }) => (await svc(ConnectionsService)).disconnect(await requireUser(), data.id))
export const selectGoogleConnection = createServerFn({ method: 'POST' })
  .validator(project.extend({ id: z.string().nullable() }))
  .handler(async ({ data }) => (await svc(ConnectionsService)).select(await requireProject(data.projectId), data.id))
export const inspectGoogleSheet = createServerFn({ method: 'POST' })
  .validator(project.extend({ url: z.string().min(1).max(2048) }))
  .handler(async ({ data }) => {
    const ctx = await requireProject(data.projectId)
    return (await svc(SheetImportsService)).info(ctx.user.id, ctx.project.id, data.url)
  })
export const previewGoogleSheet = createServerFn({ method: 'POST' })
  .validator(app.extend({ source: SheetSource }))
  .handler(async ({ data }) => {
    const ctx = await requireApp(data.projectId, data.appId)
    return (await svc(SheetImportsService)).prepare(ctx.user.id, ctx.project.id, ctx.app.id, data.source)
  })
export const getSheetImports = createServerFn({ method: 'POST' })
  .validator(project)
  .handler(async ({ data }) => (await svc(SheetImportsService)).list(await requireProject(data.projectId)))
export const updateSheetImport = createServerFn({ method: 'POST' })
  .validator(record.extend({ version: z.number().int().positive(), mapping: SheetMapping }))
  .handler(async ({ data }) => (await svc(SheetImportsService)).update(await requireProject(data.projectId), data.id, data.version, data.mapping))
export const confirmSheetImport = createServerFn({ method: 'POST' })
  .validator(app.extend({ id: z.string().min(1), version: z.number().int().positive() }))
  .handler(async ({ data }) => (await svc(SheetImportsService)).confirm(await requireApp(data.projectId, data.appId), data.id, data.version))
