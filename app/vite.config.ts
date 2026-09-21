import { unwatchFile, watchFile } from 'node:fs'
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
 * it once, and both this plugin and the SSR bundle get the same module instance. That same fact is
 * why a rebuilt backend needs a new process rather than a new server — see scripts/dev.mjs.
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
      //
      // Polled with watchFile rather than handed to `server.watcher`: the bundle lives outside the
      // Vite root, where chokidar drops it without saying so, and this ran for six hours across
      // several rebuilds without once restarting. A rebuild then means new routes 404 and stale
      // client modules throw on identifiers the source no longer has — with nothing on screen to
      // suggest the server is the thing that is out of date. Polling also survives the atomic
      // rename a bundler writes with, which `fs.watch` on a path does not.
      // Exit rather than `server.restart()`: the plugin's `import('@lovbase/api')` would return the
      // same cached module, so a restart in this process re-mounts the old backend. scripts/dev.mjs
      // brings the process back. Close Nest first, or a reload leaks a pair of connection pools.
      let reloading = false
      watchFile(bundle, { interval: 400 }, (now, before) => {
        if (reloading || now.mtimeMs === before.mtimeMs) return
        reloading = true
        unwatchFile(bundle)
        server.config.logger.info('api bundle changed, reloading the dev server')
        void nest.close().catch(() => {}).finally(() => process.exit(75))
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
  /**
   * Source maps in the production build.
   *
   * A React error arrived from production as `Minified React error #185` and nothing else, and
   * three attempts to find it by reading the code narrowed nothing — the component that loops is
   * whichever one the stack would have named. Shipping maps costs bytes nobody downloads unless
   * they open devtools, and buys back the ability of the build to say where it broke. Debugging by
   * inspection when the machine will tell you is a choice to work with less than you have.
   */
  build: { sourcemap: true },
  // Dev only: sandbox containers reach this server as host.docker.internal.
  server: { allowedHosts: ['host.docker.internal', 'localhost'] },
  plugins: [
    lovbaseApi(),
    // `consolePiping` mirrors every browser console line into this terminal (`enhancedLogs` is a
    // different thing — it annotates console calls with their source, which is harmless). One
    // repeated warning then becomes tens of thousands of lines and the dev server dies of heap
    // exhaustion; that happened five times in a day, from a hydration mismatch, an error-boundary
    // loop, an auth notice, an empty iframe src and a missing key. The browser console still has
    // all of it — it just stops being able to take the server down.
    devtools({ consolePiping: { enabled: false } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
