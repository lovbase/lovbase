import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { plugin } from 'bun'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import type pg from 'pg'
import type { UIMessage } from 'ai'
import type { ProjectCtx } from '../src/modules/auth/access.service'
import { AccessService } from '../src/modules/auth/access.service'
import { SchemaService } from '../src/database/schema.service'
import { parseSkill } from '../src/modules/agent/skill-format'
import { refreshSkillContext, skillOutput } from '../src/modules/agent/skill-context'

// Production's Rspack rule imports Markdown as source, rather than Bun's rendered HTML.
plugin({ name: 'skill-markdown-source', setup(build) {
  build.onLoad({ filter: /\/agent\/skills\/.*\.md$/ }, args => ({ exports: { default: readFileSync(args.path, 'utf8') }, loader: 'object' }))
} })
const { SkillsService } = await import('../src/modules/agent/skills.service')
const { AgentService } = await import('../src/modules/agent/agent.service')

const db = new PGlite()
let tail = Promise.resolve()
async function query(sql: string, params?: unknown[]) {
  const result = await db.query(sql, params)
  return { rows: result.rows, rowCount: result.affectedRows || result.rows.length }
}
const pool = { query, connect: async () => {
  const previous = tail
  let release!: () => void
  tail = new Promise(resolve => { release = resolve })
  await previous
  return { query, release }
} } as unknown as pg.Pool
const schema = new SchemaService(pool)
const service = new SkillsService(pool, schema)
let count = 0
async function fixture() {
  const id = `skilltest${++count}`, userId = `${id}user`
  await pool.query('INSERT INTO public."user"(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$2,now(),now())', [userId, `${id}@test.invalid`])
  await pool.query('INSERT INTO public.lb_projects(id,owner_id,ir) VALUES($1,$2,$3)', [id, userId, '{"entities":[]}'])
  const project = (await pool.query('SELECT * FROM public.lb_projects WHERE id=$1', [id])).rows[0]
  return { project, user: { id: userId } } as ProjectCtx
}
const markdown = (name = 'project-guide') => `---\nname: ${name}\ndescription: A project-specific guide\n---\nFollow these project conventions.`
const item = (items: Awaited<ReturnType<typeof service.catalogue>>, name: string) => items.find(s => s.name === name)!
beforeAll(async () => { await schema.ready() }, 30_000)
afterAll(async () => { await db.close() })

describe('skill import format', () => {
  test('parses standard YAML scalars, BOM and Windows line endings', () => {
    expect(parseSkill('\uFEFF---\r\nname: "my-skill"\r\ndescription: >-\r\n  Help with\r\n  project tasks\r\n---\r\n# Instructions')).toEqual({
      name: 'my-skill', description: 'Help with project tasks', body: '# Instructions',
    })
  })
  test('rejects missing metadata, malformed YAML, invalid names, empty bodies and oversized Unicode files', () => {
    for (const raw of ['# No frontmatter', '---\nname: guide\n---\nBody', '---\nname: [\n---\nBody', markdown('UPPERCASE'), markdown('bad--name'), markdown().replace('Follow these project conventions.', ''), markdown() + '中'.repeat(24_000)]) {
      expect(() => parseSkill(raw)).toThrow()
    }
  })
})

describe('project skills and personal preferences', () => {
  test('built-ins start enabled, core skills are fixed and catalogue excludes instructions', async () => {
    const ctx = await fixture(), catalogue = await service.catalogue(ctx)
    expect(catalogue).toHaveLength(4)
    expect(catalogue.every(s => s.enabled && s.source === 'builtin')).toBe(true)
    expect(catalogue.filter(s => s.alwaysEnabled).map(s => s.name).toSorted()).toEqual(['build-ui', 'modeling-checklist'])
    expect(catalogue.every(s => !('body' in s))).toBe(true)
    await expect(service.setEnabled(ctx, item(catalogue, 'build-ui').id, false)).rejects.toThrow('always enabled')
    await expect(service.remove(ctx, item(catalogue, 'build-ui').id)).rejects.toThrow('Custom skill not found')
  })
  test('imports and toggles persist across service instances and are isolated per user and project', async () => {
    const ctx = await fixture(), other = await fixture()
    const imported = item(await service.import(ctx, 'SKILL.md', markdown()), 'project-guide')
    expect(imported.enabled).toBe(true)
    expect(imported.source).toBe('project')
    const fresh = new SkillsService(pool, schema)
    expect(item(await fresh.catalogue(ctx), 'project-guide').enabled).toBe(true)
    expect((await fresh.enabledFor(ctx.project.id, ctx.user.id)).some(s => s.name === 'project-guide')).toBe(true)
    expect((await fresh.enabledFor(ctx.project.id, other.user.id)).some(s => s.name === 'project-guide')).toBe(false)
    expect((await fresh.catalogue(other)).some(s => s.name === 'project-guide')).toBe(false)
    await pool.query('INSERT INTO public.lb_project_skill_preferences(user_id,project_id,enabled_ids) VALUES($1,$2,$3::text[])', [other.user.id, ctx.project.id, [imported.id]])
    await fresh.setEnabled(ctx, imported.id, false)
    expect((await fresh.enabledFor(ctx.project.id, ctx.user.id)).some(s => s.name === 'project-guide')).toBe(false)
    expect((await fresh.enabledFor(ctx.project.id, other.user.id)).some(s => s.name === 'project-guide')).toBe(true)
    const crm = item(await fresh.catalogue(ctx), 'crm-patterns')
    await fresh.setEnabled(ctx, crm.id, false)
    expect(item(await new SkillsService(pool, schema).catalogue(ctx), 'crm-patterns').enabled).toBe(false)
    expect(item(await fresh.catalogue(other), 'crm-patterns').enabled).toBe(true)
  })
  test('requires SKILL.md and rejects built-in and project name collisions without modifying the original', async () => {
    const ctx = await fixture()
    await expect(service.import(ctx, 'guide.md', markdown())).rejects.toThrow('SKILL.md')
    await expect(service.import(ctx, 'SKILL.md', markdown('build-ui'))).rejects.toThrow('already exists')
    const results = await Promise.allSettled([service.import(ctx, 'SKILL.md', markdown()), service.import(ctx, 'SKILL.md', markdown())])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect((await service.catalogue(ctx)).filter(s => s.source === 'project')).toHaveLength(1)
  })
  test('existing access checks and service boundaries reject unauthorized and cross-project operations', async () => {
    const ctx = await fixture(), other = await fixture()
    const access = new AccessService({ api: { getSession: async () => ({ user: { id: other.user.id, email: 'other@test.invalid' } }) } } as any,
      { get: async () => ({ isAdmin: false, plan: 'free' }) } as any, { find: async () => ctx.project } as any, {} as any, { adminEmails: [] } as any)
    await expect(access.requireProject(new Headers(), ctx.project.id)).rejects.toThrow('Project not found')
    const forged = { ...ctx, user: other.user }
    await expect(service.catalogue(forged)).rejects.toThrow('Project not found')
    await expect(service.import(forged, 'SKILL.md', markdown())).rejects.toThrow('Project not found')
    const custom = item(await service.import(ctx, 'SKILL.md', markdown()), 'project-guide')
    await expect(service.setEnabled(other, custom.id, true)).rejects.toThrow('Skill not found')
    await expect(service.remove(other, custom.id)).rejects.toThrow('Custom skill not found')
    // Names are unique within a project, not globally.
    expect(item(await service.import(other, 'SKILL.md', markdown()), 'project-guide').id).not.toBe(custom.id)
  })
  test('deletion clears preferences and reimport does not resurrect another user’s selection; project deletion cascades', async () => {
    const ctx = await fixture(), other = await fixture()
    const custom = item(await service.import(ctx, 'SKILL.md', markdown()), 'project-guide')
    await pool.query('INSERT INTO public.lb_project_skill_preferences(user_id,project_id,enabled_ids) VALUES($1,$2,$3::text[])', [other.user.id, ctx.project.id, [custom.id]])
    await service.remove(ctx, custom.id)
    expect((await service.enabledFor(ctx.project.id, other.user.id)).some(s => s.name === 'project-guide')).toBe(false)
    const replaced = item(await service.import(ctx, 'SKILL.md', markdown()), 'project-guide')
    expect(replaced.id).not.toBe(custom.id)
    expect((await service.enabledFor(ctx.project.id, other.user.id)).some(s => s.name === 'project-guide')).toBe(false)
    await pool.query('DELETE FROM public.lb_projects WHERE id=$1', [ctx.project.id])
    expect((await pool.query('SELECT * FROM public.lb_project_skills WHERE project_id=$1', [ctx.project.id])).rows).toHaveLength(0)
    expect((await pool.query('SELECT * FROM public.lb_project_skill_preferences WHERE project_id=$1', [ctx.project.id])).rows).toHaveLength(0)
  })
  test('agent load_skill uses only the current enabled snapshot, and old tool messages lose disabled instructions', async () => {
    const ctx = await fixture()
    const custom = item(await service.import(ctx, 'SKILL.md', markdown()), 'project-guide')
    const active = await service.enabledFor(ctx.project.id, ctx.user.id)
    const agent = Object.create(AgentService.prototype) as any
    agent.sheetImports = { enabled: false }
    const tool = agent.tools(ctx.project, {}, 'app', ctx.user.id, undefined, undefined, async () => true, active).load_skill
    expect(await tool.execute({ name: 'project-guide' })).toEqual({ name: 'project-guide', instructions: 'Follow these project conventions.' })
    expect(await tool.execute({ name: 'another-project-guide' })).toHaveProperty('error')
    const history = [{ id: 'assistant', role: 'assistant', parts: [{ type: 'tool-load_skill', toolCallId: 'load', state: 'output-available', input: { name: 'project-guide' }, output: skillOutput(active, 'project-guide') }] }] as UIMessage[]
    await service.setEnabled(ctx, custom.id, false)
    const disabled = await service.enabledFor(ctx.project.id, ctx.user.id)
    expect(service.index(disabled)).not.toContain('project-guide')
    expect(skillOutput(disabled, 'project-guide')).toHaveProperty('error')
    expect((refreshSkillContext(history, disabled)[0].parts[0] as any).output).not.toHaveProperty('instructions')
    expect((history[0].parts[0] as any).output).toHaveProperty('instructions')
  })
})
