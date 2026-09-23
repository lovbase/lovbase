import { useSyncExternalStore } from 'react'
import { useT } from '../lib/i18n'
import { readTheme, setTheme, subscribeTheme, themeOnServer, type ThemeChoice as Choice } from '../lib/theme'

/**
 * Three-way theme control.
 *
 * The stored value arrives through useSyncExternalStore rather than an effect that setStates:
 * localStorage is exactly the external system that hook is for, and it is the one shape that lets
 * a value legitimately differ between server and client — React renders the server snapshot during
 * hydration and re-renders with the real one immediately after, with nothing to report as a
 * mismatch. An effect would be a second render for something knowable all along.
 */
export function ThemeChoice() {
  const t = useT()
  const choice = useSyncExternalStore(subscribeTheme, readTheme, themeOnServer)

  const options: [Choice, string][] = [
    ['light', t('settings.theme.light', 'Light')],
    ['dark', t('settings.theme.dark', 'Dark')],
    ['system', t('settings.theme.system', 'System')],
  ]

  return (
    <div className="inline-flex rounded-lg border border-edge p-0.5">
      {options.map(([id, label]) => (
        <button key={id} type="button" aria-pressed={choice === id} onClick={() => setTheme(id)}
          className={`px-2.5 py-1 rounded-md text-[12px] cursor-pointer transition-colors ${
            choice === id ? 'bg-fg text-ink' : 'text-fg-dim hover:text-fg'
          }`}>
          {label}
        </button>
      ))}
    </div>
  )
}
