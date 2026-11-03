import { createFileRoute, redirect } from '@tanstack/react-router'
import { templateById } from '@lovbase/core/templates'
import { getTemplates } from '../functions/templates'
import { TemplatesPage } from '../components/TemplatesPage'
import { seoHead } from '../lib/seo'

export const Route = createFileRoute('/templates')({
  validateSearch: (s: Record<string, unknown>): { template?: string; remix?: boolean; community?: string } => ({
    template: typeof s.template === 'string' ? s.template : undefined,
    community: typeof s.community === 'string' ? s.community : undefined,
    remix: s.remix === '1' || s.remix === 1 || s.remix === true ? true : undefined,
  }),
  // Older `?template=` links land on the template's own page, which is the one search engines see.
  beforeLoad: ({ search }) => {
    if (search.template && templateById(search.template))
      throw redirect({
        to: '/templates/$templateId',
        params: { templateId: search.template },
        search: { remix: search.remix, lang: search.lang },
        statusCode: 301,
        replace: true,
      })
  },
  loader: () => getTemplates(),
  head: () => seoHead('templates'),
  component: TemplatesIndex,
})

function TemplatesIndex() {
  const { user } = Route.useLoaderData()
  const { community } = Route.useSearch()
  return <TemplatesPage signedIn={!!user} community={community} />
}
