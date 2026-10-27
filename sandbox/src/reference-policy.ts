/** Shared by the API, sandbox endpoint and trusted pi extension. Never normalize hostile paths. */
export function referencePath(path: string): string {
  if (!path || path.length > 500 || path.includes('\\') || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || path.split('/').some(part => !part || part === '.' || part === '..')
    || path.includes(':')) throw new Error('Invalid reference path')
  return path
}

export function referenceDestination(path: string): string {
  referencePath(path)
  const parts = path.toLowerCase().split('/')
  const name = parts.at(-1)!
  if (parts.some(part => ['.git', '.pi', '.agents', '.claude', '.codex', '.github', 'node_modules', 'dist'].includes(part))
    || ['agents.md', 'claude.md', 'package.json', 'bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
      'bunfig.toml', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnp.cjs', '.pnp.loader.mjs'].includes(name)
    || name.startsWith('.env') || /^(vite|vitest|eslint|prettier|postcss|tailwind|next|tsconfig)\./.test(name)
    || ['src/lib/lovbase.ts', 'src/lib/analytics.ts', 'src/main.tsx', 'index.html'].includes(path.toLowerCase())) {
    throw new Error(`Protected application path: ${path}`)
  }
  return path
}

export type ReferenceCopyFile = { path: string; content: string; encoding: 'base64'; sha256: string }
