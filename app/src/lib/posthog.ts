import posthog from 'posthog-js'

// Product analytics, off unless a key is configured at build time.
//
// There used to be a hardcoded `phc_` default here. A public project key is fine in client code —
// that is how PostHog works — but as a *default* it meant anyone self-hosting shipped their users'
// behaviour, session replay included, to whoever built the image. `VITE_*` is inlined at build
// time, so they could not even turn it off without rebuilding. Opt-in is the only defensible
// default for something that can be self-hosted.
const KEY = import.meta.env.VITE_POSTHOG_KEY ?? ''
// Same-origin so content blockers do not drop the calls; see the ingest controller. It has to be
// an absolute URL — a bare path left the client unable to send anything.
const HOST = import.meta.env.VITE_POSTHOG_HOST ?? null
const hostFor = () => HOST ?? `${window.location.origin}/ingest`

let started = false

/** Browser only. Safe to call more than once. */
export function initAnalytics() {
  if (started || typeof window === 'undefined' || !KEY) return
  started = true
  // Exposed the way PostHog's own snippet does, so the integration can be inspected from the
  // console in any environment.
  ;(window as unknown as Record<string, unknown>).posthog = posthog
  posthog.init(KEY, {
    api_host: hostFor(),
    ui_host: 'https://us.posthog.com',   // links in the toolbar still point at the real app
    // Autocapture floods the stream with clicks on a builder UI; the events below are the ones
    // that answer whether people come back and change their schema.
    autocapture: false,
    capture_pageview: false,      // sent manually so client-side route changes are counted
    capture_pageleave: true,
    persistence: 'localStorage+cookie',
    respect_dnt: true,
    // Session replay is on: watching someone stall in the builder explains more than any funnel.
    // Inputs are masked because prompts and app data would otherwise be recorded verbatim, and
    // anything marked data-private (rows from a user's own database) is masked too.
    disable_session_recording: false,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '[data-private]',
      recordCrossOriginIframes: false,   // the preview iframe is the user's own app
    },
  })
}

export type Identity = { id: string; email?: string; plan?: string; isAdmin?: boolean }

/** Attach the session to the person. Called once the loader knows who they are. */
export function identify(user: Identity | null) {
  if (!started) return
  if (!user) return
  posthog.identify(user.id, {
    email: user.email,
    plan: user.plan,
    is_admin: user.isAdmin ?? false,
  })
}

export function resetIdentity() {
  if (started) posthog.reset()
}

/**
 * PostHog's own idea of the current address came out as a bundle URL rather than the page, and it
 * rides along on events it sends itself ($pageleave). Registering the address on every navigation
 * fixes those too, instead of only the pageview we send here.
 */
export function pageview(path: string) {
  if (!started || typeof window === 'undefined') return
  const url = window.location.origin + path
  try { posthog.register({ $current_url: url, $pathname: path }) } catch { /* keep going */ }
  posthog.capture('$pageview', { $current_url: url, $pathname: path, path })
}

/**
 * The product's own vocabulary. Kept small on purpose: each one answers a question from the
 * validation plan — do people get a schema, do they come back and change it, do they publish,
 * and where do they hit the paywall.
 */
export type LovbaseEvent =
  | 'signed_up'
  | 'project_created'
  | 'message_sent'
  | 'schema_applied'
  | 'ui_generated'
  | 'app_published'
  | 'app_unpublished'
  | 'preview_opened'
  | 'upgrade_clicked'
  | 'out_of_credits'
  | 'locale_switched'

export function track(event: LovbaseEvent, props: Record<string, unknown> = {}) {
  if (started) posthog.capture(event, props)
}
