import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { templateById } from '@lovbase/core/templates'
import { getTemplates } from '../functions/templates'
import { TemplatesPage } from '../components/TemplatesPage'
import { Container, MarketingFooter, MarketingHeader } from '../components/marketing/MarketingChrome'
import { useT } from '../lib/i18n'
import { seoNoIndex, templateHead } from '../lib/seo'

/** One page per built-in template, with its own title, description, card image and breadcrumbs. */
export const Route = createFileRoute('/templates_/$templateId')({
  validateSearch: (s: Record<string, unknown>): { remix?: boolean } => ({
    remix: s.remix === '1' || s.remix === 1 || s.remix === true ? true : undefined,
  }),
  loader: async ({ params }) => {
    const template = templateById(params.templateId)
    if (!template) throw notFound()
    return { template, user: (await getTemplates()).user }
  },
  head: ({ loaderData }) => (loaderData ? templateHead(loaderData.template) : seoNoIndex('Template not found · Lovbase')),
  component: TemplatePage,
  notFoundComponent: TemplateMissing,
})

function TemplatePage() {
  const { template, user } = Route.useLoaderData()
  const { remix } = Route.useSearch()
  return <TemplatesPage signedIn={!!user} template={template} remix={remix} />
}

function TemplateMissing() {
  const t = useT()
  return (
    <div className="mk min-h-screen bg-panel text-fg antialiased">
      <MarketingHeader />
      <main>
        <Container className="py-28 sm:py-36 text-center">
          <h1 className="font-serif text-[32px] sm:text-[40px] leading-[1.15]">
            {t('tpl.missing.title', 'There is no template at this address.')}
          </h1>
          <Link to="/templates"
            className="inline-flex items-center gap-2 mt-8 h-11 px-5 rounded-full bg-fg text-panel text-[14.5px] font-medium hover:opacity-85 transition-opacity">
            {t('tpl.page.all', 'All templates')} <ArrowRight className="size-4" />
          </Link>
        </Container>
      </main>
      <MarketingFooter />
    </div>
  )
}
