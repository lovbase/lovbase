import 'reflect-metadata'
import { Logger, type INestApplication, type NestApplicationOptions } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { EmbeddedExpressAdapter } from './embedded.adapter'
import type express from 'express'
import { AppModule } from './app.module'

export type ApiOptions = {
  /** Mount onto an Express app the caller owns (the web server does this). Omit to get a fresh one. */
  express?: express.Express
}

/**
 * Builds the Nest application. Body parsing is off on purpose: several endpoints need the bytes
 * exactly as they arrived — Stripe signs the raw body, Better Auth parses its own — and the rest
 * were fetch handlers already, so they read the stream themselves (see common/http.ts).
 */
export async function createApi(opts: ApiOptions = {}): Promise<INestApplication> {
  // NestFactory.create picks its overload by looking at the second argument, so the adapter can
  // not be passed as `undefined` — the options object would be read as the adapter and dropped.
  const options: NestApplicationOptions = { bodyParser: false, logger: ['error', 'warn', 'log'] }
  const app = opts.express
    ? await NestFactory.create(AppModule, new EmbeddedExpressAdapter(opts.express), options)
    : await NestFactory.create(AppModule, options)
  app.enableShutdownHooks()
  await app.init()
  new Logger('api').log('nest ready')
  return app
}
