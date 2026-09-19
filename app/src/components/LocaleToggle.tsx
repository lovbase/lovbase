import { LOCALES, useI18n } from '../lib/i18n'
import { track } from '../lib/posthog'

/** Two locales, so a segmented control rather than a dropdown: both options stay visible. */
export function LocaleToggle({ className = '' }: { className?: string }) {
  const { locale, setLocale } = useI18n()
  return (
    <div className={`inline-flex rounded-lg border border-edge p-0.5 ${className}`}>
      {LOCALES.map((l) => (
        <button key={l.id} type="button" onClick={() => { setLocale(l.id); track('locale_switched', { locale: l.id }) }}
          aria-pressed={locale === l.id}
          className={`px-2 py-0.5 rounded-md text-[11.5px] cursor-pointer transition-colors ${
            locale === l.id ? 'bg-fg text-ink' : 'text-fg-dim hover:text-fg'
          }`}>
          {l.label}
        </button>
      ))}
    </div>
  )
}
