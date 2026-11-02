import path from 'node:path'
import { defineConfig } from 'vite-plus'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// allowedHosts: the preview URL host is dynamic (sandbox preview domain). Do not change host/port.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  // `bun run format` / `bun run typecheck` read these: oxfmt with the old prettier settings, and
  // tsgo type errors reported through the lint pass (`--quiet` keeps lint warnings out of it).
  fmt: { semi: false, singleQuote: true, printWidth: 110, trailingComma: 'all', arrowParens: 'always' },
  lint: {
    ignorePatterns: ['dist/**', 'src/components/ui/**'],
    options: { typeAware: true, typeCheck: true },
  },
})
