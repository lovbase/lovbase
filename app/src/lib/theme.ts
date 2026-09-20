/**
 * Which theme, and where that answer is kept.
 *
 * "System" is a real preference and not the absence of one — it means follow the machine,
 * including when the machine changes its mind at sunset. It is stored as the *absence* of the key,
 * which is the contract the boot script in `__root.tsx` reads: only 'dark' and 'light' are
 * choices, and anything else — missing, or left by an older build — asks the machine. Both sides
 * have to apply that same rule or the first paint is one theme while the control says another.
 */
export type ThemeChoice = 'light' | 'dark' | 'system'

export const THEME_KEY = 'lovbase-theme'

/** Anything that is not one of the two explicit choices means "follow the machine". */
export const themeFromStored = (stored: string | null | undefined): ThemeChoice =>
  stored === 'dark' || stored === 'light' ? stored : 'system'

export const readTheme = (): ThemeChoice => {
  try { return themeFromStored(localStorage.getItem(THEME_KEY)) } catch { return 'system' }
}

/** The server cannot know; "system" is the honest answer before the browser has spoken. */
export const themeOnServer = (): ThemeChoice => 'system'

/** True when this choice should render dark right now — `system` asks the machine. */
export const isDark = (choice: ThemeChoice, prefersDark: boolean): boolean =>
  choice === 'dark' || (choice === 'system' && prefersDark)

const listeners = new Set<() => void>()
export const subscribeTheme = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

export function setTheme(next: ThemeChoice) {
  document.documentElement.classList.toggle('dark', isDark(next, matchMedia('(prefers-color-scheme: dark)').matches))
  try {
    if (next === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, next)
  } catch { /* private mode: the choice lasts this session */ }
  for (const fn of listeners) fn()
}
