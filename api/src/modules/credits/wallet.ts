import type pg from 'pg'

/** All callers hold credits:<userId> advisory lock, then the user row, in this order. */
export async function walletReady(db: pg.PoolClient, userId: string) {
  const r = await db.query('SELECT credits_bonus,wallet_lots_ready FROM public."user" WHERE id=$1 FOR UPDATE', [userId])
  if (!r.rows[0]) throw new Error('Account not found')
  if (r.rows[0].wallet_lots_ready) return
  // Never guess which historical purchases paid for past usage. Protect the opening balance.
  const amount = Math.max(0, r.rows[0].credits_bonus)
  if (amount) await db.query(`INSERT INTO public.lb_wallet_lots(user_id,source,credits,remaining) VALUES($1,'legacy',$2,$2)`, [userId, amount])
  await db.query('UPDATE public."user" SET wallet_lots_ready=true WHERE id=$1', [userId])
}

export async function refreshWallet(db: pg.PoolClient, userId: string) {
  await db.query(`UPDATE public."user" SET credits_bonus=(SELECT coalesce(sum(remaining),0)::int FROM public.lb_wallet_lots WHERE user_id=$1),
    paid_credit_locked=credit_debt>0 WHERE id=$1`, [userId])
}

export async function addWalletGrant(db: pg.PoolClient, userId: string, grantId: string, amount: number, source: string) {
  await walletReady(db, userId)
  if (amount < 0) {
    await spendLots(db, userId, -amount, `admin:${grantId}`, true)
    return
  }
  const u = await db.query('SELECT credit_debt FROM public."user" WHERE id=$1', [userId])
  const settled = source === 'purchase' ? Math.min(amount, u.rows[0].credit_debt) : 0
  await db.query(`INSERT INTO public.lb_wallet_lots(user_id,grant_id,source,credits,remaining,debt_settled)
    VALUES($1,$2,$3,$4,$5,$6)`, [userId, grantId, source, amount, amount - settled, settled])
  if (settled) {
    await db.query(`INSERT INTO public.lb_credit_debt_entries(entry_key,user_id,delta,grant_id,reason)
      VALUES($1,$2,$3,$4,'purchase settles refund debt')`, [`purchase:${grantId}`, userId, -settled, grantId])
    await db.query('UPDATE public."user" SET credit_debt=credit_debt-$2 WHERE id=$1', [userId, settled])
  }
  await refreshWallet(db, userId)
}

/** Paid FIFO first; gifts are separate lots. Locked purchased credits cannot fund new work. */
export async function spendLots(db: pg.PoolClient, userId: string, amount: number, entryKey: string, admin = false) {
  await walletReady(db, userId)
  const lots = await db.query(`SELECT l.* FROM public.lb_wallet_lots l JOIN public."user" u ON u.id=l.user_id
    WHERE l.user_id=$1 AND remaining>0 AND ($2 OR NOT u.paid_credit_locked OR l.source<>'purchase')
    ORDER BY CASE WHEN l.source='purchase' THEN 0 ELSE 1 END,l.created_at,l.id FOR UPDATE OF l`, [userId, admin])
  for (const lot of lots.rows) {
    const debit = Math.min(amount, lot.remaining)
    if (!debit) break
    await db.query(`INSERT INTO public.lb_wallet_spends(entry_key,lot_id,credits) VALUES($1,$2,$3)`, [entryKey, lot.id, debit])
    await db.query('UPDATE public.lb_wallet_lots SET remaining=remaining-$2,consumed=consumed+$2 WHERE id=$1', [lot.id, debit])
    amount -= debit
  }
  await refreshWallet(db, userId)
}
