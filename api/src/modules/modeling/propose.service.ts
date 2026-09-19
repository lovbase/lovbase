import { Injectable } from '@nestjs/common'
import { diffIR, isDestructive, type Change } from '@lovbase/core/diff'
import { IR, assignIds, newId, validateIR, type IR as IRType } from '@lovbase/core/ir'
import { ProjectsService } from '../projects/projects.service'
import type { Project } from '../projects/project.types'
import { ApplyService } from './apply.service'

export type ProposalResult = {
  applied: boolean
  needsConfirmation?: boolean
  pendingId?: string
  changes: Change[]
}

/** Resolve link targets given as a dbName or display name (new entities in the same proposal have no id yet). */
function resolveLinks(ir: IRType): IRType {
  const byKey = new Map<string, string>()
  for (const e of ir.entities) { byKey.set(e.id, e.id); byKey.set(e.dbName, e.id); byKey.set(e.name, e.id) }
  return {
    ...ir,
    entities: ir.entities.map((e) => ({
      ...e,
      fields: e.fields.map((f) => (f.type === 'link' && f.linkTo && byKey.has(f.linkTo) ? { ...f, linkTo: byKey.get(f.linkTo)! } : f)),
    })),
  }
}

/** The single path by which a schema changes — the agent, the data API and the UI all come through here. */
@Injectable()
export class ProposeService {
  constructor(private readonly projects: ProjectsService, private readonly applier: ApplyService) {}

  /** Validate a full next-IR (from the LLM or from an external agent) before it reaches the differ. */
  parse(input: unknown): IRType {
    const ir = resolveLinks(assignIds(IR.parse(input)))
    const errors = validateIR(ir)
    if (errors.length) throw new Error('IR 校验失败: ' + errors.join('; '))
    return ir
  }

  /** Non-destructive → applied now; destructive → pending human confirmation. */
  async propose(project: Project, next: IRType): Promise<ProposalResult> {
    const changes = diffIR(project.ir, next)
    if (changes.length === 0) {
      await this.projects.log(project.id, 'agent', { note: '没有需要变更的内容', changes: [] })
      return { applied: true, changes: [] }
    }
    if (changes.some(isDestructive)) {
      const id = newId('p')
      await this.applier.savePending(project.id, id, project.ir, next, changes)
      await this.projects.log(project.id, 'agent', { note: '有破坏性变更,等待确认', changes, pendingId: id })
      return { applied: false, needsConfirmation: true, pendingId: id, changes }
    }
    await this.applier.apply(project.id, next, changes)
    return { applied: true, changes }
  }
}
