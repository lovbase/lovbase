export type WalletEntry = { id: string; at: string; kind: 'test' | 'admin' | 'debit'; credits: number | null }

/** Replay actual wallet debits, consuming test purchases first. Unknown legacy debits fail closed. */
export function replayTestWallet(entries: WalletEntry[], current: number) {
  let test = 0, admin = 0
  const ordered = entries.toSorted((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  // Same-timestamp credits and consumption have no reliable historical ordering.
  for (let i = 1; i < ordered.length; i++)
    if (ordered[i].at === ordered[i - 1].at && ordered[i].kind !== ordered[i - 1].kind)
      throw new Error('Ambiguous simultaneous wallet entries')
  for (const e of ordered) {
    if (e.credits === null) throw new Error('Historical wallet debit is missing; cannot reconstruct wallet reliably')
    if (!Number.isSafeInteger(e.credits)) throw new Error('Invalid wallet entry')
    if (e.kind === 'test') {
      if (e.credits <= 0) throw new Error('Invalid purchase grant')
      test += e.credits
    } else if (e.kind === 'admin' && e.credits > 0) admin += e.credits
    else {
      const debit = Math.abs(e.credits)
      if (e.kind === 'debit' && debit > test + admin) throw new Error('Wallet debit exceeds available wallet')
      const fromTest = Math.min(test, debit)
      test -= fromTest
      admin = Math.max(0, admin - (debit - fromTest))
    }
  }
  if (test + admin !== current) throw new Error(`Wallet reconciliation failed: replay=${test + admin}, current=${current}`)
  return { remove: test, preserve: admin }
}
