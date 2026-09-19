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
app.use(express.static('dist/client'))
app.use(async (req, res, next) => {
  try {
    sendFetchResponse(res, await start.fetch(await toFetchRequest(req)))
  } catch (err) {
    next(err)
  }
})

const port = Number(process.env.PORT ?? 3008)
app.listen(port, '0.0.0.0', () => console.log(`lovbase on :${port}`))
