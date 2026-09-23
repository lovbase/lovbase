import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n'

export function ThemeToggle() {
  const t = useT()
  const [dark, setDark] = useState<boolean | null>(null)
  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'))
  }, [])

  function toggle() {
    const next = document.documentElement.classList.toggle('dark')
    try { localStorage.setItem('lovbase-theme', next ? 'dark' : 'light') } catch {}
    setDark(next)
  }

  return (
    <button onClick={toggle} aria-label={t('settings.toggleTheme', 'Toggle theme')}
      className="size-7 flex items-center justify-center rounded-lg text-fg-dim
                 hover:text-fg hover:bg-panel-2 transition-colors cursor-pointer">
      {dark === false ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4.5" /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <path d="M21 13.2A8.6 8.6 0 0 1 10.8 3 8.6 8.6 0 1 0 21 13.2z" />
        </svg>
      )}
    </button>
  )
}
