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
    if (!cfg) throw new Error('未配置模型:到「设置」里填你自己的 API key')
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
    if (!p) throw new Error('待确认的变更不存在或已过期')
    if (p.stale) {
      const msg = '结构在这组变更提出之后又改过,已作废;请重新描述一次'
      await (await svc(ProjectsService)).log(project.id, 'error', { message: '这组变更提出之后结构又改过,已作废;请重新描述一次' })
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
    if (p) await (await svc(ProjectsService)).log(project.id, 'agent', { note: '已放弃这组变更', changes: [] })
    return { ok: true }
  })
