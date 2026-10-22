import type pg from 'pg'
import { createHash } from 'node:crypto'

export const TEST_MIGRATION = 'stripe-test-to-live-v1'
const fields = 'id,plan,plan_since,period_start,credits_bonus,stripe_customer_id,stripe_subscription_id,stripe_paid_start,stripe_paid_until,stripe_status,stripe_interval,stripe_cancel_at_period_end,stripe_account_id,stripe_mode'
export const migrationHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function migrationSnapshot(db: Pick<pg.Pool, 'query'>, id: string) {
  const user = (await db.query(`SELECT ${fields} FROM public."user" WHERE id=$1`, [id])).rows[0]
  const grants = (await db.query('SELECT * FROM public.lb_credit_grants WHERE user_id=$1 ORDER BY created_at,id', [id])).rows
  const usage = (await db.query('SELECT id,created_at,credits,wallet_debit FROM public.lb_credits WHERE user_id=$1 ORDER BY created_at,id', [id])).rows
  const sessions = (await db.query('SELECT * FROM public.lb_checkout_sessions WHERE user_id=$1 ORDER BY created_at,id', [id])).rows
  return { user, grants, usage, sessions }
}
export async function applyTestMigration(pool: pg.Pool, report: { migration: string; accounts: { id: string; fingerprint?: string; wallet?: { preserve: number }; downgrade?: boolean; blocked?: string }[] }) {
  if (report.migration !== TEST_MIGRATION || report.accounts.some(a=>a.blocked || !a.fingerprint || !a.wallet || !Number.isSafeInteger(a.wallet.preserve) || a.wallet.preserve<0))
    throw new Error('Migration report contains unresolved accounts; nothing applied')
  for (const a of report.accounts) {
    const db = await pool.connect()
    try {
      await db.query('BEGIN')
      const control = await db.query('SELECT paused FROM public.lb_billing_control WHERE id=1 FOR SHARE')
      if (!control.rows[0]?.paused) throw new Error('Billing maintenance must remain enabled')
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['credits:'+a.id])
      await db.query('SELECT id FROM public."user" WHERE id=$1 FOR UPDATE',[a.id])
      if ((await db.query('SELECT 1 FROM public.lb_billing_migrations WHERE user_id=$1 AND migration=$2',[a.id,TEST_MIGRATION])).rowCount) { await db.query('ROLLBACK');continue }
      const current = await migrationSnapshot(db,a.id)
      if (migrationHash(current)!==a.fingerprint) throw new Error(`Account changed since preview: ${a.id}`)
      await db.query('INSERT INTO public.lb_billing_migrations(user_id,migration,before_state,report) VALUES($1,$2,$3,$4)',[a.id,TEST_MIGRATION,JSON.stringify(current),JSON.stringify(a)])
      await db.query(`UPDATE public."user" SET credits_bonus=$2,plan=CASE WHEN $3 THEN 'free' ELSE plan END,
        period_start=CASE WHEN $3 THEN NULL ELSE period_start END,
        stripe_customer_id=NULL,stripe_subscription_id=NULL,stripe_account_id=NULL,stripe_mode=NULL,
        stripe_paid_start=NULL,stripe_paid_until=NULL,stripe_status=NULL,stripe_interval=NULL,stripe_cancel_at_period_end=false WHERE id=$1`,[a.id,a.wallet!.preserve,a.downgrade])
      await db.query(`INSERT INTO public.lb_billing_sync(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET version=lb_billing_sync.version+1`,[a.id])
      await db.query('COMMIT')
    } catch(error) { await db.query('ROLLBACK');throw error } finally { db.release() }
  }
}
