import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

const publicFiles = ['/offline.html', '/favicon.svg', '/favicon.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png']

/** Emit only into Start's client build; never turn SSR documents into an SPA cache. */
export function pwa(): Plugin {
  return {
    name: 'lovbase:pwa',
    apply: 'build',
    generateBundle(_options, bundle) {
      if (this.environment.name !== 'client') return
      const assets = Object.keys(bundle).filter(name => /\.(?:js|css|woff2?|png|svg|jpg|webp)$/.test(name)).toSorted().map(name => `/${name}`)
      const source = readFileSync(new URL('./sw.js', import.meta.url), 'utf8')
      const hash = createHash('sha256').update(source).update(JSON.stringify(assets))
      for (const file of [...publicFiles, '/manifest.webmanifest']) {
        hash.update(readFileSync(new URL(`../public${file}`, import.meta.url)))
      }
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: source
          .replace('__PWA_VERSION__', hash.digest('hex').slice(0, 16))
          .replace('__PWA_PUBLIC_FILES__', JSON.stringify(publicFiles))
          .replace('__PWA_ASSETS__', JSON.stringify(assets)),
      })
    },
  }
}
