import { parseDocument } from 'yaml'
import { SKILL_MAX_BYTES } from '@lovbase/core/skills'
import { DomainError } from '../../common/errors'

export type Skill = { name: string; description: string; body: string }

/** Agent Skills frontmatter, including quoted and multiline YAML scalars. */
export function parseSkill(raw: string): Skill {
  if (Buffer.byteLength(raw, 'utf8') > SKILL_MAX_BYTES) throw new DomainError('Skill must be 64 KiB or smaller.')
  const match = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/)
  if (!match) throw new DomainError('Skill requires YAML frontmatter with name and description.')
  let meta: Record<string, unknown>
  try {
    const doc = parseDocument(match[1])
    if (doc.errors.length) throw doc.errors[0]
    const value = doc.toJS({ maxAliasCount: 0 })
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a mapping')
    meta = value
  } catch {
    throw new DomainError('Skill frontmatter must be valid YAML.')
  }
  const name = typeof meta.name === 'string' ? meta.name.trim() : ''
  const description = typeof meta.description === 'string' ? meta.description.trim() : ''
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
    throw new DomainError('Skill name must be 1–64 lowercase letters, numbers or single hyphens.')
  if (!description || description.length > 1024) throw new DomainError('Skill description must be 1–1024 characters.')
  const body = match[2].trim()
  if (!body) throw new DomainError('Skill instructions cannot be empty.')
  return { name, description, body }
}
