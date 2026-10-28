import { LOCALES, useI18n } from '../lib/i18n'
import { useLocation } from '@tanstack/react-router'
import { track } from '../lib/posthog'

/** Two locales, so a segmented control rather than a dropdown: both options stay visible. */
export function LocaleToggle({ className = '', seoUrl = false }: { className?: string; seoUrl?: boolean }) {
  const { locale, setLocale } = useI18n()
  const location = useLocation()

  function changeLocale(id: (typeof LOCALES)[number]['id']) {
    setLocale(id)
    track('locale_switched', { locale: id })
    if (!seoUrl || typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (id === 'zh') url.searchParams.set('lang', 'zh')
    else url.searchParams.delete('lang')
    window.location.assign(`${location.pathname}${url.search}${url.hash}`)
  }

  return (
    <div className={`inline-flex rounded-lg border border-edge p-0.5 ${className}`}>
      {LOCALES.map((l) => (
        <button key={l.id} type="button" onClick={() => changeLocale(l.id)}
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
