import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'
import { STRIPE_EVENTS } from '../src/modules/billing/stripe-contract'

const path = fileURLToPath(new URL('../../app/.env', import.meta.url))
const env = parse(readFileSync(path, 'utf8'))
const origin = new URL(env.BETTER_AUTH_URL || 'http://localhost:3008')
if (!['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error('This listener is only for local testing')
const child = spawn('stripe', ['listen', '--latest', '--forward-to', `${origin.origin}/api/billing/webhook`, '--events', STRIPE_EVENTS.join(',')], { stdio: ['ignore', 'pipe', 'pipe'] })
let saved = false
function line(text: string) {
  const secret = text.match(/whsec_[A-Za-z0-9]+/)?.[0]
  if (secret && !saved) {
    let contents = readFileSync(path, 'utf8')
    const key = 'STRIPE_WEBHOOK_SECRET'
    contents = new RegExp(`^${key}=.*$`, 'm').test(contents) ? contents.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${secret}`) : `${contents.trimEnd()}\n${key}=${secret}\n`
    writeFileSync(path, contents, { mode: 0o600 })
    saved = true
    console.log('Webhook signing secret saved to app/.env. Restart the local web service if it is already running.')
  }
  console.log(text.replace(/whsec_[A-Za-z0-9]+/g, '[signing secret saved locally]'))
}
createInterface({ input: child.stdout }).on('line', line)
createInterface({ input: child.stderr }).on('line', line)
child.on('error', () => { console.error('Unable to launch Stripe CLI. Run stripe login first.'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
