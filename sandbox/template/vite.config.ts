import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// allowedHosts: the preview URL host is dynamic (sandbox preview domain). Do not change host/port.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
})
