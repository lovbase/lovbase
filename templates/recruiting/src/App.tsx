import { RecruitingApp } from './RecruitingApp'
import { recruitingClient } from './client'
import { defaultLocale } from './template-config'
export function App() {
  return (
    <div className="recruiting-viewport">
      <RecruitingApp client={recruitingClient} initialLocale={defaultLocale} />
    </div>
  )
}
