// Runs the dev server, and starts it again when the backend bundle changes.
//
// The Nest backend is `@lovbase/api`, marked SSR-external so that Node resolves it once and the
// Vite plugin and the SSR bundle share a single DI container. The cost of that is Node's ESM cache:
// the module is keyed by URL and never re-read, so `rspack --watch` rewriting the bundle changes
// nothing in a running process. Vite's own `server.restart()` does not help either — it re-runs the
// plugin, whose `import('@lovbase/api')` returns the same cached module.
//
// This went unnoticed for hours at a time: a rebuilt backend meant new routes answering 404 and
// stale client modules throwing on identifiers the source no longer had, with nothing on screen to
// suggest the server was the thing out of date. Replacing the process is the only way to pick up a
// new bundle, so the plugin exits with RELOAD and this brings it back.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Chosen to be distinct from anything Vite or Node exits with, so a real crash still stops. */
const RELOAD = 75

// Resolved rather than looked up on PATH: a spawned shell does not inherit the `node_modules/.bin`
// entry a package script would have had, and the failure is a bare "vite: command not found".
const vite = fileURLToPath(new URL('../node_modules/.bin/vite', import.meta.url))

function run() {
  const child = spawn(vite, ['dev', '--port', process.env.PORT ?? '3008'], { stdio: 'inherit' })
  child.on('exit', (code, signal) => {
    if (signal) return // Ctrl-C and friends: let it go.
    if (code === RELOAD) {
      console.log('\n[dev] backend rebuilt — starting over\n')
      run()
      return
    }
    process.exit(code ?? 0)
  })
}

run()
