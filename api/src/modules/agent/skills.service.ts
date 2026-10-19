import { Injectable } from '@nestjs/common'
import type pg from 'pg'
import type { SkillCatalogueItem } from '@lovbase/core/skills'
import { DomainError, NotFound } from '../../common/errors'
import { randomId } from '../../common/ids'
import { InjectPool } from '../../database/pool.provider'
import { SchemaService } from '../../database/schema.service'
import type { ProjectCtx } from '../auth/access.service'
import { parseSkill, type Skill } from './skill-format'
import modeling from './skills/modeling-checklist.md'
import importSheet from './skills/import-spreadsheet.md'
import crm from './skills/crm-patterns.md'
import buildUi from './skills/build-ui.md'

export type { Skill } from './skill-format'
type StoredSkill = Skill & { id: string; source: 'builtin' | 'project' }
const INLINED = new Set(['modeling-checklist', 'build-ui'])

@Injectable()
export class SkillsService {
  readonly all: StoredSkill[] = [modeling, importSheet, crm, buildUi].map(raw => {
    const skill = parseSkill(raw)
    return { id: `builtin:${skill.name}`, source: 'builtin', name: skill.name, description: skill.description, body: skill.body }
  })
  private readonly defaultIds = this.all.filter(s => !INLINED.has(s.name)).map(s => s.id)

  constructor(
    @InjectPool() private readonly pool: pg.Pool,
    private readonly schema: SchemaService,
  ) {}

  /** Core rules remain in the system prompt regardless of the optional skills selected. */
  find(name: string): Skill | null {
    return this.all.find(s => s.name === name) ?? null
  }

  index(skills: Skill[] = this.all) {
    return skills.filter(s => !INLINED.has(s.name)).map(s => `- ${s.name}: ${s.description}`).join('\n')
  }

  async catalogue(ctx?: ProjectCtx): Promise<SkillCatalogueItem[]> {
    if (ctx) await this.authorize(ctx)
    const { skills, enabled } = ctx
      ? await this.state(ctx.project.id, ctx.user.id)
      : { skills: this.all, enabled: this.defaultIds }
    return skills.map(s => ({
      id: s.id, name: s.name, description: s.description, source: s.source,
      alwaysEnabled: INLINED.has(s.name), enabled: INLINED.has(s.name) || enabled.includes(s.id),
    }))
  }

  /** A fresh snapshot per turn, shared by the index and load_skill for that turn. */
  async enabledFor(projectId: string, userId: string): Promise<Skill[]> {
    const { skills, enabled } = await this.state(projectId, userId)
    return skills.filter(s => INLINED.has(s.name) || enabled.includes(s.id))
  }

  async import(ctx: ProjectCtx, fileName: string, content: string) {
    await this.authorize(ctx)
    if (fileName !== 'SKILL.md') throw new DomainError('Choose a single file named SKILL.md.')
    const skill = parseSkill(content)
    if (this.find(skill.name)) throw new DomainError('A skill with this name already exists.')
    const id = `skill_${randomId(18)}`
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO public.lb_project_skills(id,project_id,name,description,body) VALUES($1,$2,$3,$4,$5)`,
        [id, ctx.project.id, skill.name, skill.description, skill.body])
      await this.writeEnabled(client, ctx, id, true)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      if ((error as { code?: string }).code === '23505') throw new DomainError('A skill with this name already exists.')
      throw error
    } finally { client.release() }
    return this.catalogue(ctx)
  }

  async setEnabled(ctx: ProjectCtx, id: string, enabled: boolean) {
    const skills = await this.catalogue(ctx)
    const skill = skills.find(s => s.id === id)
    if (!skill) throw new NotFound('Skill not found.')
    if (skill.alwaysEnabled) throw new DomainError('This built-in skill is always enabled.')
    await this.writeEnabled(this.pool, ctx, id, enabled)
    return this.catalogue(ctx)
  }

  async remove(ctx: ProjectCtx, id: string) {
    await this.authorize(ctx)
    // Built-ins have no database row and cannot be removed through this path.
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query('DELETE FROM public.lb_project_skills WHERE id=$1 AND project_id=$2 RETURNING id', [id, ctx.project.id])
      if (!result.rowCount) throw new NotFound('Custom skill not found.')
      await client.query('UPDATE public.lb_project_skill_preferences SET enabled_ids=array_remove(enabled_ids,$1) WHERE project_id=$2', [id, ctx.project.id])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
    return this.catalogue(ctx)
  }

  private async authorize(ctx: ProjectCtx) {
    await this.schema.ready()
    const result = await this.pool.query('SELECT 1 FROM public.lb_projects WHERE id=$1 AND owner_id=$2', [ctx.project.id, ctx.user.id])
    if (!result.rowCount) throw new NotFound('Project not found')
  }

  private async state(projectId: string, userId: string) {
    await this.schema.ready()
    const [custom, preferences] = await Promise.all([
      this.pool.query('SELECT id,name,description,body FROM public.lb_project_skills WHERE project_id=$1 ORDER BY created_at,id', [projectId]),
      this.pool.query('SELECT enabled_ids FROM public.lb_project_skill_preferences WHERE project_id=$1 AND user_id=$2', [projectId, userId]),
    ])
    const skills: StoredSkill[] = [...this.all, ...custom.rows.map(s => ({ id: s.id, name: s.name, description: s.description, body: s.body, source: 'project' as const }))]
    const enabled: string[] = preferences.rows[0]?.enabled_ids ?? this.defaultIds
    return { skills, enabled }
  }

  private async writeEnabled(db: Pick<pg.Pool, 'query'>, ctx: ProjectCtx, id: string, enabled: boolean) {
    const initial = this.defaultIds.filter(value => value !== id)
    if (enabled) initial.push(id)
    // One atomic upsert preserves other selections when tabs change different skills at once.
    await db.query(`INSERT INTO public.lb_project_skill_preferences(user_id,project_id,enabled_ids) VALUES($1,$2,$3::text[])
      ON CONFLICT(user_id,project_id) DO UPDATE SET enabled_ids = CASE WHEN $5 THEN
        array_append(array_remove(lb_project_skill_preferences.enabled_ids,$4),$4)
        ELSE array_remove(lb_project_skill_preferences.enabled_ids,$4) END`,
    [ctx.user.id, ctx.project.id, initial, id, enabled])
  }
}
