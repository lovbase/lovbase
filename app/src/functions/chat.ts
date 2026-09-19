import { createServerFn } from '@tanstack/react-start'
import { ApplyService, ConversationService, SandboxService, SkillsService, parseActivity, svc } from '@lovbase/api'
import { requireApp, requireProject, requireUser } from './_ctx'

/** Skills the agent can load, for the composer's skill picker. */
export const listSkills = createServerFn().handler(async () => {
  await requireUser()
  return (await svc(SkillsService)).catalogue()
})

/** The saved transcript, for resuming a run after a refresh. */
export const chatState = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    const conversation = await svc(ConversationService)
    const running = await conversation.runActive(project.id)
    return {
      chat: (await conversation.getChat(project.id)) as any,
      pendingIds: await (await svc(ApplyService)).listPendingIds(project.id),
      running,
      progress: running ? await conversation.loadProgress(project.id) : null,
    }
  })

/** Drop everything after (and including) a message, so a user can edit and resend. */
export const truncateChat = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; messageId: string }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    await (await svc(ConversationService)).truncateChat(project.id, data.messageId)
    return { ok: true }
  })

/** Append messages produced outside the chat stream (e.g. a sandbox agent turn) to the transcript. */
export const appendChat = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; messages: unknown[] }) => d)
  .handler(async ({ data }) => {
    const { project } = await requireProject(data.projectId)
    await (await svc(ConversationService)).appendChat(project.id, data.messages)
    return { ok: true }
  })

/** What Boris is doing right now in this app's sandbox. Polled by the chat while a build runs. */
export const buildActivity = createServerFn({ method: 'POST' })
  .validator((d: { projectId: string; appId: string }) => d)
  .handler(async ({ data }) => {
    await requireApp(data.projectId, data.appId)
    try {
      const { jsonl } = await (await svc(SandboxService)).activity(data.appId)
      return parseActivity(jsonl)
    } catch {
      return { running: false, steps: [], text: '', code: '' }
    }
  })
