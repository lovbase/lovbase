import { createFileRoute } from '@tanstack/react-router'
import { PricingView } from '../components/marketing/PricingView'
import { viewer } from '../functions/account'
import { translate } from '../lib/i18n'

export const Route = createFileRoute('/pricing')({
  loader: () => viewer(),
  component: () => <PricingView viewer={Route.useLoaderData()} />,
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
