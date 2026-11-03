import { CrmApp } from './CrmApp'
import { crmClient } from './client'
import { defaultLocale } from './template-config'
export function App() {
  return (
    <div className="crm-viewport">
      <CrmApp client={crmClient} initialLocale={defaultLocale} />
    </div>
  )
}
