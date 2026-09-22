import type { FileUIPart } from 'ai'
import type { getProjectState, getProjects } from '../functions'

/**
 * What the home composer hands the project page it navigates to.
 *
 * Creating the project already computed everything the page needs to open, so it travels here,
 * in memory, and the page's loader takes it instead of asking the server for the same state
 * again — one round trip from the click to the page instead of four. Attachments come the same
 * way because they are data URLs and do not belong in a URL; the prompt comes this way so the
 * page does not have to navigate a second time to get it out of the address bar.
 *
 * Client-side navigation keeps the module alive; a full reload loses it, and the page simply
 * loads from the server as it would for any other project.
 */
export type ProjectStart = {
  projectId: string
  prompt: string
  files: FileUIPart[]
  state: Awaited<ReturnType<typeof getProjectState>>
  /** The sidebar, as the home page already had it — the new project is added on the way. */
  shell: Awaited<ReturnType<typeof getProjects>>
}

let start: ProjectStart | null = null
export function stashStart(s: ProjectStart) { start = s }
/** Once, and only for the project it was meant for. */
export function takeStart(projectId: string): ProjectStart | null {
  if (!start || start.projectId !== projectId) return null
  const s = start
  start = null
  return s
}
