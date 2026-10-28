// Production entry: one Node process, one port.
//
//   Nest (api/)            /api/*, /ingest/*  — the backend, mounted first
//   static                 dist/client        — the built assets
//   TanStack Start         everything else    — SSR and server functions
//
// Server functions run inside the Start handler and reach Nest providers directly (see
// `useApi` below), so there is one DI container, one set of pools, one Better Auth instance.
// `bun run --cwd api build && vite build` first; the Dockerfile does both.
import express from 'express'
import { createApi, sendFetchResponse, toFetchRequest, useApi } from '@lovbase/api'
import start from './dist/server/server.js'

const app = express()
// Railway (and Cloudflare in front of it) terminate TLS; without this the app sees the proxy's
// address and scheme, which breaks absolute URLs and auth rate limiting.
app.set('trust proxy', true)
useApi(await createApi({ express: app }))

// Vite hashes everything under /assets, so those never change; the rest of dist/client
// (favicons, logo) is small and revalidated normally.
app.use('/assets', express.static('dist/client/assets', { immutable: true, maxAge: '1y' }))
// A browser tab may request a hashed chunk from the previous deployment. Do not let that miss fall
// through to SSR (or let the CDN cache the resulting HTML error page under a JavaScript URL).
app.use('/assets', (_req, res) => {
  res.set('Cache-Control', 'no-store')
  res.status(404).type('text/plain').send('Not found')
})
// Stable PWA URLs must revalidate after a deployment, including through a CDN.
app.use(['/sw.js', '/manifest.webmanifest', '/offline.html'], (_req, res, next) => {
  res.set('Cache-Control', 'no-cache')
  next()
})
// Let TanStack Start own application routes that share a name with a public asset directory,
// such as /templates. Express's default directory redirect would otherwise loop /templates ↔
// /templates/ before SSR gets a chance to render the page.
app.use(express.static('dist/client', { redirect: false }))
app.use(async (req, res, next) => {
  try {
    sendFetchResponse(res, await start.fetch(await toFetchRequest(req)))
  } catch (err) {
    next(err)
  }
})

const port = Number(process.env.PORT ?? 3008)
app.listen(port, '0.0.0.0', () => console.log(`lovbase on :${port}`))
