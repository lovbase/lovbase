import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { referenceDestination, type ReferenceCopyFile } from '../src/reference-policy'

/** No imports from the application, no installs, no execution of copied content. */
export async function applyReferenceFiles(root: string, files: ReferenceCopyFile[]) {
  if (!Array.isArray(files) || !files.length || files.length > 2000) throw new Error('Invalid copy file count')
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('Symlink root refused')
  let total = 0
  const seen = new Set<string>()
  const decoded = files.map(file => {
    referenceDestination(file.path)
    if (seen.has(file.path) || file.encoding !== 'base64') throw new Error('Invalid copy entry')
    seen.add(file.path)
    const bytes = Buffer.from(file.content, 'base64')
    total += bytes.length
    if (bytes.length > 10 * 1024 * 1024 || total > 50 * 1024 * 1024
      || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Copy integrity or size check failed')
    return { path: file.path, bytes }
  })
  const check = async (path: string, directory = false) => {
    try {
      const stat = await lstat(path)
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Symlink or special file refused')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  // Validate the entire batch before changing any application file.
  for (const file of decoded) {
    const parts = file.path.split('/')
    for (let i = 1; i < parts.length; i++) await check(join(root, ...parts.slice(0, i)), true)
    await check(join(root, file.path))
  }
  for (const file of decoded) {
    const target = join(root, file.path)
    await mkdir(dirname(target), { recursive: true })
    // Check again after mkdir; use O_EXCL/O_NOFOLLOW for the temporary regular file.
    const parts = file.path.split('/')
    for (let i = 1; i < parts.length; i++) await check(join(root, ...parts.slice(0, i)), true)
    const temporary = join(dirname(target), `.lovbase-copy-${randomUUID()}`)
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
      try { await handle.writeFile(file.bytes) } finally { await handle.close() }
      await rename(temporary, target)
    } finally { await unlink(temporary).catch(() => {}) }
  }
  return { ok: true, files: decoded.map(file => file.path), bytes: total }
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const payload = process.argv[2]
  if (!payload?.startsWith('/tmp/lovbase-reference-')) throw new Error('Invalid copy payload')
  const { readFile } = await import('node:fs/promises')
  try {
    console.log(JSON.stringify(await applyReferenceFiles('/workspace/app', JSON.parse(await readFile(payload, 'utf8')))))
  } finally { await unlink(payload).catch(() => {}) }
}
