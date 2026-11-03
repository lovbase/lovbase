import { LedgerApp } from './LedgerApp'
import { ledgerClient } from './client'
import { defaultLocale } from './template-config'
export function App() {
  return (
    <div className="ledger-viewport">
      <LedgerApp client={ledgerClient} initialLocale={defaultLocale} />
    </div>
  )
}
