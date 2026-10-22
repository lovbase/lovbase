import 'reflect-metadata'
import { Pool } from 'pg'
import { Stripe } from 'stripe'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { STRIPE_API_VERSION } from '../src/modules/billing/stripe-contract'
import { replayTestWallet, type WalletEntry } from './lib/test-wallet'
import { TEST_MIGRATION as migration, migrationSnapshot as snapshot, migrationHash as hash, applyTestMigration } from './lib/test-migration'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
try {
  const [action, file] = process.argv.slice(2)
  if (!['preview', 'apply'].includes(action) || !file?.startsWith('/')) throw new Error('Usage: stripe:migrate preview|apply /private/report.json')
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL')
  if (!(await pool.query('SELECT paused FROM public.lb_billing_control WHERE id=1')).rows[0]?.paused) throw new Error('Pause generation, purchases and wallet changes first (lb_billing_control.paused)')
  const active = await pool.query(`SELECT id FROM public.lb_jobs WHERE status IN ('starting','running','finalizing','cancelling')
    UNION ALL SELECT id FROM public.lb_generation_runs WHERE status='running'
    UNION ALL SELECT id FROM public.lb_model_requests WHERE status IN ('pending','measured') LIMIT 1`)
  if (active.rowCount) throw new Error('Wait for active jobs, model requests and settlement to drain before migration')
  if (action === 'preview') {
    const ids = (await pool.query(`SELECT id FROM public."user" WHERE stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL
      OR id IN (SELECT user_id FROM public.lb_credit_grants WHERE source='purchase') ORDER BY id`)).rows
    if (!ids.length) {
      writeFileSync(file,JSON.stringify({migration,createdAt:new Date().toISOString(),accounts:[],note:'No Stripe associations or purchase grants; manual plans and grants preserved'},null,2)+'\n',{mode:0o600,flag:'wx'})
      console.log('No test billing associations or purchase grants to migrate. Manual plans and grants are preserved.')
      process.exitCode=0
    } else {
    const key = process.env.TEST_STRIPE_SECRET_KEY
    if (!key?.startsWith('sk_test_')) throw new Error('Supply TEST_STRIPE_SECRET_KEY securely')
    const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION })
    const account = await stripe.accounts.retrieve(null)
    if (!process.env.TEST_STRIPE_ACCOUNT_ID || account.id !== process.env.TEST_STRIPE_ACCOUNT_ID) throw new Error('Test Stripe account mismatch')
    const accounts = []
    for (const { id } of ids) {
      if ((await pool.query('SELECT 1 FROM public.lb_billing_migrations WHERE user_id=$1 AND migration=$2', [id,migration])).rowCount) continue
      const state = await snapshot(pool,id)
      try {
        const u = state.user
        if (!u.stripe_customer_id || (u.stripe_mode && u.stripe_mode !== 'test')) throw new Error('Missing or non-test customer association')
        const customer = await stripe.customers.retrieve(u.stripe_customer_id)
        if (customer.deleted || customer.livemode || customer.metadata.userId !== id) throw new Error('Test customer ownership not verified')
        if (u.stripe_subscription_id) {
          const sub = await stripe.subscriptions.retrieve(u.stripe_subscription_id)
          if (sub.livemode || sub.customer !== customer.id || sub.metadata.userId !== id) throw new Error('Test subscription ownership not verified')
        }
        const evidence = []
        for (const sid of new Set([...state.sessions.map(s=>s.id), ...state.grants.filter(g=>g.source==='purchase').map(g=>g.ref)])) {
          if (!sid) throw new Error('Purchase has no Stripe reference')
          const s = await stripe.checkout.sessions.retrieve(sid)
          if (s.livemode || s.customer !== customer.id || s.metadata?.userId !== id) throw new Error('Test Checkout ownership not verified')
          evidence.push({ id: s.id, livemode: s.livemode, customer: s.customer })
        }
        const entries: WalletEntry[] = state.grants.map(g=>({id:'grant:'+g.id,at:new Date(g.created_at).toISOString(),kind:g.source==='purchase'?'test':'admin',credits:g.credits}))
        if (state.grants.some(g=>!['purchase','admin'].includes(g.source))) throw new Error('Unknown grant source')
        // If every credit is still present and there are no clawbacks, no wallet debit occurred.
        const untouched = state.grants.every(g=>g.credits>0) && state.grants.reduce((n,g)=>n+g.credits,0)===u.credits_bonus
        if (!untouched) entries.push(...state.usage.filter(c=>c.credits>0).map(c=>({id:'usage:'+c.id,at:new Date(c.created_at).toISOString(),kind:'debit' as const,credits:c.wallet_debit})))
        const wallet = replayTestWallet(entries,u.credits_bonus)
        accounts.push({id,fingerprint:hash(state),wallet,downgrade:u.plan==='pro'&&!!u.stripe_subscription_id,evidence,state})
      } catch (error) { accounts.push({id,blocked:error instanceof Stripe.errors.StripeError ? 'Test Stripe record could not be verified' : error instanceof Error ? error.message : 'Unverified account'}) }
    }
    writeFileSync(file,JSON.stringify({migration,testAccount:account.id,createdAt:new Date().toISOString(),accounts},null,2)+'\n',{mode:0o600,flag:'wx'})
    console.log(JSON.stringify({report:file,ready:accounts.filter(a=>!('blocked' in a)).length,blocked:accounts.filter(a=>'blocked' in a).map(a=>({id:a.id,reason:'blocked' in a?a.blocked:''}))}))
    }
  } else {
    const backup = process.env.BILLING_BACKUP_FILE
    if (!backup || statSync(backup).size===0) throw new Error('Require a verified nonempty BILLING_BACKUP_FILE before applying')
    const report = JSON.parse(readFileSync(file,'utf8'))
    await applyTestMigration(pool,report)
    console.log('Migration applied idempotently. Keep maintenance enabled until direct roles, queue priorities and storage inventory are verified.')
  }
} catch(error) {
  console.error(error instanceof Error && !(error instanceof Stripe.errors.StripeError) ? error.message : 'Migration failed; inspect protected logs')
  process.exitCode=1
} finally { await pool.end() }
