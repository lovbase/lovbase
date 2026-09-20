import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Runs the Nest backend inside the dev server, mounted ahead of Vite's own middleware, so `/api/*`
 * and `/ingest/*` behave exactly as they do in production (see server.mjs) — and so the server
 * functions share the one DI container rather than booting a second set of pools.
 *
 * `@lovbase/api` is SSR-external below, which is what makes "the one container" true: Node resolves
 * it once, and both this plugin and the SSR bundle get the same module instance.
 */
function lovbaseApi(): Plugin {
  // Resolved relative to this config file so the watcher works from any cwd.
  const bundle = fileURLToPath(new URL('../api/dist/index.js', import.meta.url))

  return {
    name: 'lovbase:api',
    async configureServer(server) {
      const [{ default: express }, { createApi, useApi }] = await Promise.all([
        import('express'),
        import('@lovbase/api'),
      ])
      const app = express()
      const nest = await createApi({ express: app })
      useApi(nest)
      server.middlewares.use(app)

      // The backend is a bundle, so `rspack --watch` rewriting it does not reload the instance this
      // process already imported. Restart the dev server on a rebuild — and close the old Nest app
      // first, or every restart leaks a pair of connection pools.
      server.watcher.add(bundle)
      server.watcher.on('change', (file) => {
        if (file !== bundle) return
        void nest.close().catch(() => {}).then(() => server.restart())
      })
    },
  }
}

// Plain Node target: `vite build` emits dist/client (static assets) and dist/server/server.js
// (a fetch handler). server.mjs serves both behind Nest; there is no platform plugin.
const config = defineConfig({
  // One React for SSR: vendored UI deps otherwise get a second copy via SSR dep pre-bundling.
  resolve: { tsconfigPaths: true, dedupe: ['react', 'react-dom'] },
  // The backend is a built bundle with decorator metadata; Vite must not re-transform it.
  ssr: { external: ['@lovbase/api'] },
  // Dev only: sandbox containers reach this server as host.docker.internal.
  server: { allowedHosts: ['host.docker.internal', 'localhost'] },
  plugins: [
    lovbaseApi(),
    devtools({ enhancedLogs: { enabled: false } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
