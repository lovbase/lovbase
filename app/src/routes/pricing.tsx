import { createFileRoute } from '@tanstack/react-router'
import { PricingView } from '../components/marketing/PricingView'
import { viewer } from '../functions/account'
import { translate } from '../lib/i18n'

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
  // `head` runs outside React, so it reads the stored locale directly rather than through useT().
  head: () => ({
    meta: [
      { title: translate('meta.pricing.title', 'Pricing · Lovbase') },
      {
        name: 'description',
        content: translate(
          'meta.pricing.description',
          'Priced per usage, not per seat. The free plan already builds a real Postgres database; self-hosting is always free.',
        ),
      },
    ],
  }),
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
