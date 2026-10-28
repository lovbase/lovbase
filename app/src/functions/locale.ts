import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { localeFromCookie, localeFromValue, type Locale } from '../lib/i18n'

/**
 * Which language to server-render in.
 *
 * The cookie is the user's own choice; `Accept-Language` is the best guess for someone who has
 * not made one yet. Reading either here is what lets the first paint be correct — the client
 * cannot tell the server what it prefers before the server has already replied.
 */
export const getLocale = createServerFn({ method: 'GET' })
  .validator((data?: { lang?: unknown }) => ({ lang: localeFromValue(data?.lang) }))
  .handler(async ({ data }): Promise<Locale> => {
  const headers = getRequest().headers
  if (data.lang) return data.lang
  const chosen = localeFromCookie(headers.get('cookie'))
  if (chosen) return chosen
  return (headers.get('accept-language') ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  })
