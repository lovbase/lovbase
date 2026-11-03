import { HelpdeskApp } from './HelpdeskApp'
import { helpdeskClient } from './client'
import { defaultLocale } from './template-config'
export function App() {
  return (
    <div className="helpdesk-viewport">
      <HelpdeskApp client={helpdeskClient} initialLocale={defaultLocale} />
    </div>
  )
}
