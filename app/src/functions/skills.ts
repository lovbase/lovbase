import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { SKILL_MAX_BYTES } from '@lovbase/core/skills'
import { SkillsService, svc } from '@lovbase/api'
import { requireProject, requireUser } from './_ctx'

const project = z.object({ projectId: z.string().min(1) })

export const getSkills = createServerFn({ method: 'POST' })
  .validator(z.object({ projectId: z.string().min(1).optional() }))
  .handler(async ({ data }) => {
    const ctx = data.projectId ? await requireProject(data.projectId) : undefined
    if (!ctx) await requireUser()
    return (await svc(SkillsService)).catalogue(ctx)
  })

export const importSkill = createServerFn({ method: 'POST' })
  .validator(project.extend({ fileName: z.literal('SKILL.md'), content: z.string().min(1).max(SKILL_MAX_BYTES) }))
  .handler(async ({ data }) => {
    const ctx = await requireProject(data.projectId)
    return (await svc(SkillsService)).import(ctx, data.fileName, data.content)
  })

export const setSkillEnabled = createServerFn({ method: 'POST' })
  .validator(project.extend({ id: z.string().min(1), enabled: z.boolean() }))
  .handler(async ({ data }) => {
    const ctx = await requireProject(data.projectId)
    return (await svc(SkillsService)).setEnabled(ctx, data.id, data.enabled)
  })

export const deleteSkill = createServerFn({ method: 'POST' })
  .validator(project.extend({ id: z.string().min(1) }))
  .handler(async ({ data }) => {
    const ctx = await requireProject(data.projectId)
    return (await svc(SkillsService)).remove(ctx, data.id)
  })
