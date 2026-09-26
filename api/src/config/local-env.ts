import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'

/** Fill local development values without overriding variables injected by the deployment. */
export function fillMissingEnv(
  contents: string,
  target: Record<string, string | undefined> = process.env,
) {
  for (const [key, value] of Object.entries(parse(contents))) {
    if (!target[key]?.trim()) target[key] = value
  }
}

export function loadLocalEnv(path: string): boolean {
  try {
    fillMissingEnv(readFileSync(path, 'utf8'))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
