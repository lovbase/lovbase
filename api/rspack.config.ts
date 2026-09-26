import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import type { ExternalItemFunctionData, ExternalItemValue, ExternalsType } from '@rspack/core'

// The backend is bundled, not tsc-emitted, for two reasons: SWC applies `emitDecoratorMetadata`
// (which esbuild cannot, and which Nest's DI needs), and the workspace packages ship raw .ts
// sources that a bundler can pull in directly — so `core` needs no build of its own.
const dir = fileURLToPath(new URL('.', import.meta.url))

// Everything from node_modules stays external: this runs on a server where the dependencies are
// installed anyway, and bundling `pg` (native bindings) or `better-auth` only invites trouble.
const external = (
  { request }: ExternalItemFunctionData,
  cb: (err?: Error, result?: ExternalItemValue, type?: ExternalsType) => void,
) => {
  const bare = request && !request.startsWith('.') && !request.startsWith('/') && !request.startsWith('@lovbase/')
  cb(undefined, bare ? `module ${request}` : undefined)
}

export default defineConfig({
  entry: {
    // Imported in-process by the web app (server functions reach Nest providers through it).
    index: './src/index.ts',
    // Standalone HTTP server, for running the API as its own service.
    main: './src/main.ts',
    // BullMQ consumers live only in this process; the HTTP application imports no worker entry.
    worker: './src/worker.ts',
  },
  target: 'node20.0',
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  devtool: 'source-map',
  externalsType: 'module',
  externals: [external],
  output: {
    path: `${dir}dist`,
    filename: '[name].js',
    module: true,
    chunkFormat: 'module',
    library: { type: 'module' },
    // tsc writes the public types into dist/types; a bundle rebuild must not sweep them away.
    clean: { keep: 'types' },
  },
  resolve: {
    extensions: ['.ts', '.js', '.json'],
    // The workspace packages export `.ts` paths; resolve them as written.
    extensionAlias: { '.js': ['.ts', '.js'] },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            target: 'es2022',
            parser: { syntax: 'typescript', decorators: true },
            // Nest resolves constructor dependencies from design:paramtypes metadata.
            transform: { legacyDecorator: true, decoratorMetadata: true },
          },
        },
      },
      // Agent skills are Markdown with frontmatter, inlined as strings.
      { test: /\.md$/, type: 'asset/source' },
    ],
  },
  optimization: { minimize: false },
})
