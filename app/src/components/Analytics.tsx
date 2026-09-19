import { useEffect } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { initAnalytics, pageview } from '../lib/posthog'

/**
 * Starts analytics in the browser and reports one pageview per route change. Rendered inside the
 * root document so it never runs during SSR, where `window` does not exist.
 */
export function Analytics() {
  const path = useRouterState({ select: (s) => s.location.pathname })

  useEffect(() => { initAnalytics() }, [])
  useEffect(() => { if (path) pageview(path) }, [path])

  return null
}
