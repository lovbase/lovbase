import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n'

type Choice = 'light' | 'dark' | 'system'

/**
 * Three states, because "system" is a real preference and not the absence of one — it means follow
 * the machine, including when the machine changes its mind at sunset. It is stored as the absence
 * of the key, which is what the boot script in __root already reads.
 *
 * Rendered only after mount: the server cannot know which of the three is selected, and a wrong
 * selection swapping on hydration is exactly the flicker the boot script exists to prevent.
 */
export function ThemeChoice() {
  const t = useT()
  const [choice, setChoice] = useState<Choice | null>(null)

  useEffect(() => {
    let stored: string | null = null
    try { stored = localStorage.getItem('lovbase-theme') } catch { /* private mode */ }
    setChoice(stored === 'dark' || stored === 'light' ? stored : 'system')
  }, [])

  function pick(next: Choice) {
    setChoice(next)
    const dark = next === 'dark' || (next === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', dark)
    try {
      if (next === 'system') localStorage.removeItem('lovbase-theme')
      else localStorage.setItem('lovbase-theme', next)
    } catch { /* private mode: the choice lasts this session */ }
  }

  const options: [Choice, string][] = [
    ['light', t('settings.theme.light', '浅色')],
    ['dark', t('settings.theme.dark', '深色')],
    ['system', t('settings.theme.system', '跟随系统')],
  ]

  return (
    <div className="inline-flex rounded-lg border border-edge p-0.5" role="radiogroup">
      {options.map(([id, label]) => (
        <button key={id} type="button" role="radio" aria-checked={choice === id} onClick={() => pick(id)}
          className={`px-2.5 py-1 rounded-md text-[12px] cursor-pointer transition-colors ${
            choice === id ? 'bg-fg text-ink' : 'text-fg-dim hover:text-fg'
          }`}>
          {label}
        </button>
      ))}
    </div>
  )
}
