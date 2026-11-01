import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { settingsUrl, type SettingsTab } from '../components/SettingsDialog'
import { seoNoIndex } from '../lib/seo'

/**
 * Settings are a dialog now (see SettingsDialog). This address stays because Stripe, the billing
 * portal and OAuth returns all point at it: it forwards to the home page with the dialog open on
 * the right tab, keeping the query (checkout ids) and the fragment (MCP and connection results,
 * which the server never sees, hence a client-side hop rather than a server redirect).
 */
export const Route = createFileRoute('/settings')({
  component: SettingsRedirect,
  head: () => seoNoIndex('Settings · Lovbase'),
})

function SettingsRedirect() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const hash = new URLSearchParams(window.location.hash.slice(1))
    const tab: SettingsTab = params.has('checkout') || params.has('canceled') || !window.location.search && document.referrer.includes('stripe.com')
      ? 'billing' : hash.has('mcp') || hash.has('connections') ? 'integrations' : 'account'
    window.location.replace(settingsUrl(tab, params.toString()) + window.location.hash)
  }, [])
  return <div className="min-h-screen bg-ink" />
}
