import { Injectable } from '@nestjs/common'
import modeling from './skills/modeling-checklist.md'
import importSheet from './skills/import-spreadsheet.md'
import crm from './skills/crm-patterns.md'
import buildUi from './skills/build-ui.md'

// Built-in agent skills (Agent Skills format: SKILL.md with frontmatter). Progressive disclosure:
// the system prompt lists name + description; the agent calls load_skill to pull the body when relevant.

export type Skill = { name: string; description: string; body: string }

const INLINED = new Set(['modeling-checklist', 'build-ui'])

function parse(raw: string): Skill {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) throw new Error('skill without frontmatter')
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { name: meta.name, description: meta.description, body: m[2].trim() }
}

@Injectable()
export class SkillsService {
  readonly all: Skill[] = [modeling, importSheet, crm, buildUi].map(parse)

  /**
   * What the agent can ask for. The modeling checklist and the UI rules are always in the system
   * prompt — nearly every turn needs one or the other, and loading them was a model round trip
   * spent on a decision that was never in doubt — so neither is offered for loading.
   */
  index() {
    return this.all.filter((s) => !INLINED.has(s.name)).map((s) => `- ${s.name}: ${s.description}`).join('\n')
  }

  find(name: string): Skill | null {
    return this.all.find((s) => s.name === name) ?? null
  }

  /** Name + description only, for the composer's skill picker. */
  catalogue() {
    return this.all.map((s) => ({ name: s.name, description: s.description }))
  }
}
