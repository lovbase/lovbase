import { createServerFn } from '@tanstack/react-start'
import type { Change } from '@lovbase/core/diff'
import { ApplyService, GenerateService, LlmService, ProjectsService, ProposeService, svc, type HistoryItem } from '@lovbase/api'
import { requireProject } from './_ctx'

export type GenerateResult = {
  applied: boolean
  needsConfirmation?: boolean
  pendingId?: string
  changes: Change[]
}

export const generateApp = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; message: string }) => {
    if (!d?.message?.trim()) throw new Error('empty message')
    return d
  })
  .handler(async ({ data }): Promise<GenerateResult> => {
    const { user, project } = await requireProject(data.projectId)
    const cfg = await (await svc(LlmService)).configFor(user.id)
    if (!cfg) throw new Error('No model configured: enter your own API key under Settings')
    const projects = await svc(ProjectsService)
    // Recent turns give the agent conversational memory; schema state comes from the IR itself.
    const history: HistoryItem[] = (await projects.history(project.id))
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .slice(-12)
      .map((r) => ({ role: r.role as 'user' | 'assistant', text: String(r.content?.message ?? '') }))
    await projects.log(project.id, 'user', { message: data.message })
    let turn
    try {
      turn = await (await svc(GenerateService)).turn(cfg, project.ir, history, data.message)
    } catch (err) {
      await projects.log(project.id, 'error', { message: err instanceof Error ? err.message : String(err) })
      throw err
    }
    await projects.log(project.id, 'assistant', { message: turn.reply })
    if (!turn.ir) return { applied: true, changes: [] }
    return (await svc(ProposeService)).propose(project, turn.ir)
  })

export const confirmPending = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; pendingId: string }) => d)
  .handler(async ({ data }): Promise<GenerateResult> => {
    const { project } = await requireProject(data.projectId)
    const applier = await svc(ApplyService)
    const p = await applier.takePending(project.id, data.pendingId, project.ir)
    if (!p) throw new Error('The pending change set does not exist or has expired')
    if (p.stale) {
      const msg = 'The schema changed after this change set was proposed, so it was discarded; describe the change again'
      await (await svc(ProjectsService)).log(project.id, 'error', { message: 'The schema changed after this change set was proposed, so it was discarded; describe the change again' })
      throw new Error(msg)
    }
    await applier.apply(project.id, p.next, p.changes)
    return { applied: true, changes: p.changes }
  })

export const discardPending = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; pendingId: string }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    const p = await (await svc(ApplyService)).takePending(project.id, data.pendingId, project.ir)
    if (p) await (await svc(ProjectsService)).log(project.id, 'agent', { note: 'Discarded this change set', changes: [] })
    return { ok: true }
  })
