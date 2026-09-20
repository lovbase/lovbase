import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { decodeLayout, type LayoutPrefs } from '../lib/layout-prefs'

/** Panel geometry for the first paint. See lib/layout-prefs.ts for why this is a cookie. */
export const getLayout = createServerFn({ method: 'GET' }).handler(async (): Promise<LayoutPrefs> =>
  decodeLayout(getRequest().headers.get('cookie')))
