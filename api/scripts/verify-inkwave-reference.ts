/** Safe, repeatable acquisition/copy sample. Never installs or runs the source repository. */
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { ReferenceFetcher } from '../src/modules/references/reference-fetch'
import { applyReferenceFiles } from '../../sandbox/tools/reference-copy'

const repository = 'https://github.com/caoxing9/inkwave-game'
const { manifest, contents } = await new ReferenceFetcher().fetch(repository, randomUUID())
const root = await realpath(await mkdtemp(join(tmpdir(), 'lovbase-inkwave-')))
const workspace = fileURLToPath(new URL('../../', import.meta.url))
await cp(join(workspace, 'sandbox/template'), root, { recursive: true, filter: path => !path.includes('node_modules') && !path.includes('/dist/') })
const selected = manifest.files.filter(file => file.path.startsWith('public/game/') || file.path.startsWith('public/downloads/') || file.path === 'LICENSE')
await applyReferenceFiles(root, selected.map(file => ({ path: file.path,
  content: Buffer.from(contents.get(file.path)!).toString('base64'), encoding: 'base64', sha256: file.sha256 })))
const original = contents.get('app/page.tsx')
if (!original) throw new Error('Source React wrapper missing')
const wrapper = Buffer.from(original).toString('utf8')
const entry = 'setSrc(`/game/index.html'
if (!wrapper.includes(entry) || !wrapper.includes('export default function Home()')) throw new Error('Source wrapper changed; inspect before adapting')
await writeFile(join(root, 'src/App.tsx'), wrapper.replace('export default function Home()', 'export function App()')
  .replace(entry, 'setSrc(`${import.meta.env.BASE_URL}game/index.html'))
const changed: string[] = []
for (const file of selected) {
  if (createHash('sha256').update(await readFile(join(root, file.path))).digest('hex') !== file.sha256) changed.push(file.path)
}
if (changed.length) throw new Error('Copy changed source files: ' + changed.join(', '))
// The game itself uses relative module/font URLs, but this one download link assumes origin root.
// Apply only this routing adaptation after proving that acquisition/copy preserved every byte.
const lobbyPath = 'public/game/src/net/lobby.js'
const lobby = await readFile(join(root, lobbyPath), 'utf8')
const downloadLink = 'href="/downloads/inkwave-local.zip"'
if (!lobby.includes(downloadLink)) throw new Error('Source download link changed; inspect before adapting')
await writeFile(join(root, lobbyPath), lobby.replace(downloadLink,
  'href="${new URL(\'../../../downloads/inkwave-local.zip\', import.meta.url).href}"'))
const report = {
  repository, commit: manifest.commit, license: manifest.license, sampleDirectory: root,
  copiedFiles: selected.length, bytes: selected.reduce((sum, file) => sum + file.size, 0), exactCopyVerified: true,
  adaptations: ['Export Home as App', 'Use import.meta.env.BASE_URL for iframe entry; preserve query/hash, invitations, metrics, original layout and language', 'Retain Lovbase main.tsx and analytics startup', 'Resolve the LAN download link relative to its module so snapshot path prefixes work'],
  adaptedReferenceFiles: [lobbyPath],
  unresolved: ['Next.js /api/rooms LAN relay requires a backend adapter', 'Next.js /api/multiplayer-status probe requires an adapter',
    'Teable beacon/credentials/data adapters are not copied', 'PeerJS Cloud/WebRTC and external WSS availability need separate real network testing',
    'LAN download archive is preserved as opaque bytes and has not been extracted or run'],
  runtime: 'Not yet tested. Acquisition/copy does not claim visual, pointer-lock or multiplayer success.',
  excluded: manifest.excluded,
}
await writeFile(join(root, 'reference-report.json'), JSON.stringify(report, null, 2))
const destination = process.argv[2] ? resolve(process.argv[2]) : undefined
if (destination) {
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'inkwave-reference-report.json'), JSON.stringify(report, null, 2))
}
console.log(JSON.stringify(report, null, 2))
