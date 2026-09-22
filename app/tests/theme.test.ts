import { describe, expect, test } from 'bun:test'
import { isDark, themeFromStored, themeOnServer } from '../src/lib/theme'

// The boot script in __root reads the same key and treats a missing one as light — the product is
// designed light-first. If these two ever disagree, the first paint is one theme and the control
// says another.

describe('themeFromStored', () => {
  test('the three explicit choices come back as themselves', () => {
    expect(themeFromStored('light')).toBe('light')
    expect(themeFromStored('dark')).toBe('dark')
    expect(themeFromStored('system')).toBe('system')
  })

  test('a missing key is light, which is what the boot script assumes', () => {
    expect(themeFromStored(null)).toBe('light')
    expect(themeFromStored(undefined)).toBe('light')
  })

  test('a value from an older build is light rather than a broken selection', () => {
    expect(themeFromStored('')).toBe('light')
    expect(themeFromStored('auto')).toBe('light')
    expect(themeFromStored('Dark')).toBe('light')
  })

  test('the server answers light before the browser has spoken', () => {
    expect(themeOnServer()).toBe('light')
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
