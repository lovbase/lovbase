/**
 * Panel geometry the server has to know before it replies.
 *
 * These used to live in localStorage, which the server cannot read: the first paint was always the
 * default and a mount effect corrected it, and since the panels animate their width, that
 * correction was visible as a bounce on every refresh. A cookie is sent with the request, so the
 * markup arrives at the right size and nothing moves. Same reasoning as the locale cookie.
 */
export type LayoutPrefs = { sidebar: boolean; sidebarProject: boolean; chat: boolean; chatWidth: number }

/**
 * `collapse` is below `min` on purpose: it is not a width the panel can have, it is how far past
 * the minimum a drag has to go before it reads as closing rather than resizing. Far enough that
 * nobody arrives there while aiming for "as narrow as possible".
 */
export const CHAT_WIDTH = { initial: 416, min: 320, max: 720, collapse: 200 } as const

export const LAYOUT_DEFAULTS: LayoutPrefs = {
  sidebar: true,
  // Collapsed on a project page: there the preview is the work, and 256px of nav takes it below
  // the width a generated app is designed against.
  sidebarProject: false,
  chat: true,
  chatWidth: CHAT_WIDTH.initial,
}

const COOKIE = 'lovbase_layout'

/** `s1-p0-c1-w416` — short enough to stay readable in devtools, and cheap on every request. */
export function encodeLayout(p: LayoutPrefs): string {
  return `s${+p.sidebar}-p${+p.sidebarProject}-c${+p.chat}-w${Math.round(p.chatWidth)}`
}

export function decodeLayout(header: string | null | undefined): LayoutPrefs {
  const raw = header?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`))?.[1]
  const m = raw?.match(/^s([01])-p([01])-c([01])-w(\d{2,4})$/)
  if (!m) return LAYOUT_DEFAULTS
  const w = Number(m[4])
  return {
    sidebar: m[1] === '1',
    sidebarProject: m[2] === '1',
    chat: m[3] === '1',
    // A width outside the range is a stale cookie from an older build, not a reason to render wrong.
    chatWidth: w >= CHAT_WIDTH.min && w <= CHAT_WIDTH.max ? w : CHAT_WIDTH.initial,
  }
}

/** Read what the browser already has, so a write changes one field and keeps the rest. */
export function readLayout(): LayoutPrefs {
  if (typeof document === 'undefined') return LAYOUT_DEFAULTS
  return decodeLayout(document.cookie)
}

export function writeLayout(patch: Partial<LayoutPrefs>) {
  if (typeof document === 'undefined') return
  const next = encodeLayout({ ...readLayout(), ...patch })
  document.cookie = `${COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`
}

