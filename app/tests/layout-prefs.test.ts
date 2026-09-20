import { describe, expect, test } from 'bun:test'
import { CHAT_WIDTH, LAYOUT_DEFAULTS, decodeLayout, encodeLayout } from '../src/lib/layout-prefs'

// The point of this cookie is that the server can render the panels at their real size. Every case
// below is one where getting it wrong puts the page on screen at one width and then moves it.

describe('decodeLayout', () => {
  test('no cookie at all is the defaults, which is a first visit', () => {
    expect(decodeLayout(null)).toEqual(LAYOUT_DEFAULTS)
    expect(decodeLayout('')).toEqual(LAYOUT_DEFAULTS)
    expect(decodeLayout('lovbase_locale=zh')).toEqual(LAYOUT_DEFAULTS)
  })

  test('round-trips what the browser wrote', () => {
    const prefs = { sidebar: false, sidebarProject: true, chat: false, chatWidth: 520 }
    expect(decodeLayout(`lovbase_layout=${encodeLayout(prefs)}`)).toEqual(prefs)
  })

  test('finds it among other cookies, wherever it sits', () => {
    const c = encodeLayout({ ...LAYOUT_DEFAULTS, chatWidth: 500 })
    expect(decodeLayout(`a=1; lovbase_layout=${c}; z=2`).chatWidth).toBe(500)
    expect(decodeLayout(`lovbase_layout=${c}`).chatWidth).toBe(500)
  })

  test('a width outside the range is a stale cookie, not a reason to render wrong', () => {
    expect(decodeLayout('lovbase_layout=s1-p0-c1-w9000').chatWidth).toBe(CHAT_WIDTH.initial)
    expect(decodeLayout('lovbase_layout=s1-p0-c1-w10').chatWidth).toBe(CHAT_WIDTH.initial)
  })

  test('anything malformed falls back whole rather than half-applying', () => {
    for (const bad of ['lovbase_layout=', 'lovbase_layout=garbage', 'lovbase_layout=s2-p0-c1-w416', 'lovbase_layout=s1-c1-w416'])
      expect(decodeLayout(bad)).toEqual(LAYOUT_DEFAULTS)
  })

  test('the project rail starts collapsed and the rest of the app does not', () => {
    expect(LAYOUT_DEFAULTS.sidebarProject).toBe(false)
    expect(LAYOUT_DEFAULTS.sidebar).toBe(true)
  })
})
