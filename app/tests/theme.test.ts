import { describe, expect, test } from 'bun:test'
import { isDark, themeFromStored, themeOnServer } from '../src/lib/theme'

// The boot script in __root reads the same key and treats a missing one as "ask the machine". If
// these two ever disagree, the first paint is one theme and the control says another.

describe('themeFromStored', () => {
  test('the two explicit choices come back as themselves', () => {
    expect(themeFromStored('light')).toBe('light')
    expect(themeFromStored('dark')).toBe('dark')
  })

  test('a missing key is "system", which is what the boot script assumes', () => {
    expect(themeFromStored(null)).toBe('system')
    expect(themeFromStored(undefined)).toBe('system')
  })

  test('a value from an older build is "system" rather than a broken selection', () => {
    expect(themeFromStored('')).toBe('system')
    expect(themeFromStored('auto')).toBe('system')
    expect(themeFromStored('Dark')).toBe('system')
  })

  test('the server answers "system" before the browser has spoken', () => {
    expect(themeOnServer()).toBe('system')
  })
})

describe('isDark', () => {
  test('an explicit choice ignores the machine', () => {
    expect(isDark('dark', false)).toBe(true)
    expect(isDark('light', true)).toBe(false)
  })

  test('"system" is the machine, which is the whole point of having it', () => {
    expect(isDark('system', true)).toBe(true)
    expect(isDark('system', false)).toBe(false)
  })
})
