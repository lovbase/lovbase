/** Shared by the skill importer and catalogue; instructions stay on the server. */
export const SKILL_MAX_BYTES = 64 * 1024

export type SkillCatalogueItem = {
  id: string
  name: string
  description: string
  source: 'builtin' | 'project'
  enabled: boolean
  alwaysEnabled: boolean
}
