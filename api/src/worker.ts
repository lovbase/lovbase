import 'reflect-metadata'
import { fileURLToPath } from 'node:url'
import { loadLocalEnv } from './config/local-env'

// Vite loads app/.env for the Web process. The Worker is a separate Node process, so load the
// same local file before importing any Nest modules that construct ConfigService. Production
// injects non-empty variables directly and therefore always wins over this development fallback.
loadLocalEnv(fileURLToPath(new URL('../../app/.env', import.meta.url)))

const [{ Logger }, { NestFactory }, { ConfigService }, { WorkerAppModule }] = await Promise.all([
  import('@nestjs/common'),
  import('@nestjs/core'),
  import('./config/config.service'),
  import('./worker-app.module'),
])

const app = await NestFactory.createApplicationContext(WorkerAppModule, {
  logger: ['error', 'warn', 'log'],
})
app.enableShutdownHooks()
const cfg = app.get(ConfigService)
const envModelConfigured = !!(
  (cfg.env.LLM_BASE_URL && cfg.env.LLM_MODEL) || cfg.env.ANTHROPIC_API_KEY
)
new Logger('worker').log(`job worker started; environment model ${envModelConfigured ? 'configured' : 'not configured'}`)
