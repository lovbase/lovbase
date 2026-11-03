import { expect, test } from 'bun:test'
import { servePublished } from '../src/published-static'

test('republishing refreshes documents and fixed-name files, retaining caching for hashed assets', async () => {
  const objects = new Map([['demo/index.html','old'],['demo/game.js','old script'],['demo/assets/game-AbCd1234.js','hashed']])
  const bucket = {get:async (key: string) => objects.has(key) ? {key,body:objects.get(key)!} : null} as any
  const first = await servePublished(bucket,'demo','/')
  expect(first?.headers.get('Cache-Control')).toBe('no-store')
  objects.set('demo/index.html','new')
  expect(await (await servePublished(bucket,'demo','/'))?.text()).toBe('new')
  expect((await servePublished(bucket,'demo','/game.js'))?.headers.get('Cache-Control')).toBe('no-cache')
  expect((await servePublished(bucket,'demo','/assets/game-AbCd1234.js'))?.headers.get('Cache-Control')).toContain('immutable')
  expect(await (await servePublished(bucket,'demo','/client/route'))?.text()).toBe('new')
  expect((await servePublished(bucket,'demo','/missing.js'))?.status).toBe(404)
  expect(await servePublished(bucket,'snap','/a/index.html')).toBeNull()
})

test('embedded games refresh their HTML and every fixed-path module after republishing', async () => {
  const objects = new Map([
    ['inkwave/game/index.html', '<script type="module" src="./src/main.js"></script>'],
    ['inkwave/game/src/main.js', 'import "./net/lobby.js"; // old'],
    ['inkwave/game/src/net/lobby.js', '// old lobby'],
    ['inkwave/game/styles/ui.css', '/* old styles */'],
  ])
  const bucket = {get:async (key: string) => objects.has(key) ? {key,body:objects.get(key)!} : null} as any
  for (const [key, old] of objects) {
    const path = key.slice('inkwave'.length)
    const response = await servePublished(bucket, 'inkwave', path)
    expect(response?.headers.get('Cache-Control')).toBe(key.endsWith('.html') ? 'no-store' : 'no-cache')
    objects.set(key, old + '\n/* new release */')
    expect(await (await servePublished(bucket, 'inkwave', path))?.text()).toBe(old + '\n/* new release */')
  }
})

test('snapshot files: the document and fixed-name files are never kept, hashed assets only by the visitor', async () => {
  const { snapshotCacheControl } = await import('../src/published-static')
  expect(snapshotCacheControl('index.html')).toBe('private, no-store')
  expect(snapshotCacheControl('dashboard')).toBe('private, no-store')
  expect(snapshotCacheControl('favicon.svg')).toBe('private, no-store')
  expect(snapshotCacheControl('assets/index-AbCd1234.js')).toBe('private, max-age=31536000, immutable')
  expect(snapshotCacheControl('assets/index-AbCd1234.css')).toBe('private, max-age=31536000, immutable')
})
