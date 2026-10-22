import { createFileRoute } from '@tanstack/react-router'
import { PricingView } from '../components/marketing/PricingView'
import { viewer } from '../functions/account'
import { translate } from '../lib/i18n'

export const Route = createFileRoute('/pricing')({
  validateSearch: (s: Record<string, unknown>): { billing?: 'monthly' | 'yearly'; canceled?: boolean; plan?: 'pro' } => ({ billing: s.billing === 'yearly' ? 'yearly' as const : 'monthly' as const, canceled: s.canceled === '1' || s.canceled === 1, plan: s.plan === 'pro' ? 'pro' as const : undefined }),
  loader: () => viewer(),
  component: () => <PricingView viewer={Route.useLoaderData()} initialBilling={Route.useSearch().billing} canceled={Route.useSearch().canceled} />,
  // `head` runs outside React, so it reads the stored locale directly rather than through useT().
  head: () => ({
    meta: [
      { title: translate('meta.pricing.title', 'Pricing · Lovbase') },
      {
        name: 'description',
        content: translate('meta.pricing.description', 'Priced per usage, not per seat. The free plan already builds a real Postgres database; self-hosting is always free.'),
      },
    ],
  }),
})
