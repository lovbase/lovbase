// Runs at build time. Runtime never reads a source checkout or the developer's filesystem.
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { isUtf8 } from 'node:buffer'
import { watch } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildInkwaveUI } from './build-inkwave-ui.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
async function tree(dir, prefix = '') {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name) || entry.name.startsWith('.env'))
      continue
    const rel = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...(await tree(path.join(dir, entry.name), rel)))
    else {
      const bytes = await readFile(path.join(dir, entry.name))
      const binary = !isUtf8(bytes) || /\.(png|jpe?g|webp|gif|ico|woff2?|zip|glb|mp3|mp4|ogg|wav)$/i.test(rel)
      files.push({
        path: rel,
        content: bytes.toString(binary ? 'base64' : 'utf8'),
        ...(binary ? { encoding: 'base64' } : {}),
      })
    }
  }
  return files
}
const definitions = [
  { id: 'inventory', title: 'Inventory', endpoint: 'inventory' },
  { id: 'product-3d', title: '3D Product Studio', endpoint: 'product-3d' },
  { id: 'inkwave', title: 'INKWAVE', static: true },
]
async function packageTemplates() {
  await buildInkwaveUI()
  const base = await tree(path.join(root, 'sandbox/template'))
  for (const template of definitions) {
    const custom = await tree(path.join(root, 'templates', template.id))
    const files = new Map(base.map((f) => [f.path, f]))
    const setText = (path, content) => files.set(path, { path, content })
    for (const f of custom) {
      if (f.path === 'provenance.json') continue
      if (f.encoding === 'base64') {
        files.set(f.path, f)
        continue
      }
      const content = f.content.replaceAll(`'@lovbase/core/${template.id}'`, "'./domain'")
      if (f.path === 'package.json') {
        const original = JSON.parse(files.get('package.json').content)
        const overrides = JSON.parse(content)
        setText(
          f.path,
          JSON.stringify(
            {
              ...original,
              ...overrides,
              dependencies: {
                ...original.dependencies,
                ...overrides.dependencies,
              },
              devDependencies: {
                ...original.devDependencies,
                ...overrides.devDependencies,
              },
            },
            null,
            2,
          ) + '\n',
        )
      } else setText(f.path, content)
    }
    if (!template.static) setText(
      'src/domain.ts',
      await readFile(path.join(root, `core/src/${template.id}.ts`), 'utf8'),
    )
    setText('src/template-config.ts', "export const defaultLocale = 'en' as const\n")
    if (!template.static) setText(
      'AGENTS.md',
      `${files.get('AGENTS.md').content}\n\n## ${template.title} template\nThis bilingual template uses the platform ${template.endpoint} API through src/client.ts for transactional business operations. Use that client for business changes; do not split an operation into separate SQL requests. Reads and other general-purpose data access may use src/lib/lovbase.ts. Keep English and Chinese UI translations together. The product studio's procedural model and material colors are intentional; preserve its editorial layout. Read-only previews may change local configuration choices but must never expose persistence commands.\n`,
    )
    await writeFile(
      path.join(root, `api/src/modules/templates/${template.id}-files.json`),
      JSON.stringify([...files.values()]),
    )
    if (template.static) {
      const preview = path.join(root, 'app/public/templates', template.id)
      await mkdir(preview, { recursive: true })
      await cp(path.join(root, 'templates', template.id, 'public'), preview, { recursive: true })
    }
  }
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
  for (const directory of ['sandbox/template', ...definitions.map((t) => `templates/${t.id}`)]) {
    watch(path.join(root, directory), { recursive: true }, (_, filename) => {
      if (filename && !/(^|[/\\])(node_modules|dist|\.git|\.env[^/\\]*)([/\\]|$)/.test(filename))
        if (!filename.endsWith('lovbase-ui.js')) changed()
    })
  }
  for (const template of definitions.filter((t) => !t.static))
    watch(path.join(root, `core/src/${template.id}.ts`), changed)
}
