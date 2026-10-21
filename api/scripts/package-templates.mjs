// Runs at build time. Runtime never reads a source checkout or the developer's filesystem.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
async function tree(dir, prefix = '') {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name) || entry.name.startsWith('.env')) continue
    const rel = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...(await tree(path.join(dir, entry.name), rel)))
    else files.push({ path: rel, content: await readFile(path.join(dir, entry.name), 'utf8') })
  }
  return files
}
async function packageTemplates() {
  const base = await tree(path.join(root, 'sandbox/template'))
  const custom = await tree(path.join(root, 'templates/inventory'))
  const files = new Map(base.map((f) => [f.path, f.content]))
  for (const f of custom) files.set(f.path, f.content.replaceAll("'@lovbase/core/inventory'", "'./domain'"))
  files.set('src/domain.ts', await readFile(path.join(root, 'core/src/inventory.ts'), 'utf8'))
  files.set('src/template-config.ts', "export const defaultLocale = 'en' as const\n")
  files.set(
    'AGENTS.md',
    `${files.get('AGENTS.md')}\n\n## Inventory template\nThis bilingual template uses the platform inventory API through src/client.ts for transactional stock and purchase operations. Use that client for inventory changes; do not split an operation into separate SQL requests. Reads and other general-purpose data access may use src/lib/lovbase.ts. Keep English and Chinese UI translations together.\n`,
  )
  await writeFile(
    path.join(root, 'api/src/modules/templates/inventory-files.json'),
    JSON.stringify([...files].map(([path, content]) => ({ path, content }))),
  )
}

await packageTemplates()
if (process.argv.includes('--watch')) {
  let timer
  let pending = Promise.resolve()
  const changed = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      pending = pending.then(packageTemplates).catch((error) => {
        console.error('Template packaging failed:', error)
        process.exitCode = 1
      })
    }, 150)
  }
  for (const directory of ['sandbox/template', 'templates/inventory']) {
    watch(path.join(root, directory), { recursive: true }, (_, filename) => {
      if (filename && !/(^|[/\\])(node_modules|dist|\.git|\.env[^/\\]*)([/\\]|$)/.test(filename)) changed()
    })
  }
  watch(path.join(root, 'core/src/inventory.ts'), changed)
}
