import { createFileRoute } from '@tanstack/react-router'
import { PricingView } from '../components/marketing/PricingView'
import { viewer } from '../functions/account'
import { seoHead } from '../lib/seo'

export const Route = createFileRoute('/pricing')({
  validateSearch: (
    s: Record<string, unknown>,
  ): { billing?: 'monthly' | 'yearly'; canceled?: boolean; checkout?: string; plan?: 'pro' } => ({
    billing: s.billing === 'yearly' ? 'yearly' : 'monthly',
    canceled: s.canceled === '1' || s.canceled === 1 || s.canceled === true ? true : undefined,
    checkout: typeof s.checkout === 'string' && /^cs_[A-Za-z0-9_]+$/.test(s.checkout) ? s.checkout : undefined,
    plan: s.plan === 'pro' ? 'pro' : undefined,
  }),
  loader: () => viewer(),
  component: Pricing,
  head: () => seoHead('pricing'),
})

function Pricing() {
  const search = Route.useSearch(),
    navigate = Route.useNavigate()
  return (
    <PricingView
      viewer={Route.useLoaderData()}
      billing={search.billing ?? 'monthly'}
      onBillingChange={(billing) =>
        void navigate({ search: (prev) => ({ ...prev, billing }), replace: true, resetScroll: false })
      }
      canceled={search.canceled}
      sessionId={search.checkout}
    />
  )
}
