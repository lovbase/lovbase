import { rspack } from '@rspack/core'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
export async function buildInkwaveUI() {
  const compiler = rspack({
    mode: 'production',
    target: 'web',
    entry: path.join(root, 'api/scripts/inkwave-ui.mjs'),
    experiments: { outputModule: true },
    output: {
      path: path.join(root, 'templates/inkwave/public/game/vendor'),
      filename: 'lovbase-ui.js',
      module: true,
      library: { type: 'module' },
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js', '.json'],
      alias: { '@': path.join(root, 'sandbox/template/src') },
      modules: [path.join(root, 'app/node_modules'), 'node_modules'],
    },
    module: { rules: [{
      test: /\.tsx?$/,
      exclude: /node_modules/,
      loader: 'builtin:swc-loader',
      options: { jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', tsx: true },
        transform: { react: { runtime: 'automatic' } },
      } },
    }] },
  })
  await new Promise((resolve, reject) => compiler.run((error, stats) => {
    compiler.close((closeError) => {
      if (error || closeError) reject(error || closeError)
      else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })))
      else resolve()
    })
  }))
}
