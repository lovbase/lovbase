import { isStaticToolUIPart, type UIMessage } from 'ai'
import type { Skill } from './skill-format'

export function skillOutput(skills: Skill[], name: string) {
  const skill = skills.find(s => s.name === name)
  return skill ? { name: skill.name, instructions: skill.body } : { error: `Skill unavailable: ${name}` }
}

/** Old tool results must not reintroduce instructions that were disabled or deleted. */
export function refreshSkillContext(messages: UIMessage[], skills: Skill[]): UIMessage[] {
  return messages.map(message => ({ ...message, parts: message.parts.map(part => {
    if (!isStaticToolUIPart(part) || part.type !== 'tool-load_skill' || part.state !== 'output-available') return part
    const name = (part.input as { name?: unknown } | undefined)?.name
    return { ...part, output: typeof name === 'string' ? skillOutput(skills, name) : { error: 'Skill unavailable' } }
  }) }))
}
