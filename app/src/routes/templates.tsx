import { createFileRoute, Link } from '@tanstack/react-router'
import { getTemplates } from '../functions/templates'
import { TemplatesGallery } from '../components/TemplatesGallery'
import { Logo } from '../components/Logo'
import { useI18n } from '../lib/i18n'
import { seoHead } from '../lib/seo'
export const Route = createFileRoute('/templates')({
  validateSearch: (s: Record<string, unknown>): { template?: string; remix?: boolean; community?: string } => ({
    template: typeof s.template === 'string' ? s.template : undefined,
    community: typeof s.community === 'string' ? s.community : undefined,
    remix: s.remix === '1' || s.remix === 1 || s.remix === true ? true : undefined,
  }),
  loader: () => getTemplates(),
  head: () => seoHead('templates'),
  component: TemplatesPage,
})
function TemplatesPage() {
  const { user } = Route.useLoaderData()
  const search = Route.useSearch()
  const { locale } = useI18n()
  return (
    <div className="min-h-screen bg-ink text-fg">
      <header className="max-w-7xl mx-auto flex items-center justify-between px-6 py-6">
        <Link to={user ? '/home' : '/'} className="flex gap-2.5 items-center font-mono font-medium">
          <Logo size={27} />
          lovbase
        </Link>
        <Link to={user ? '/home' : '/login'} search={{}} className="text-sm text-fg-mid hover:text-fg">
          {locale === 'zh' ? (user ? '返回首页' : '登录') : user ? 'Back home' : 'Log in'}
        </Link>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-10">
        <TemplatesGallery signedIn={!!user} seoUrl initialTemplate={search.template} initialRemix={search.remix} initialCommunity={search.community} />
      </main>
    </div>
  )
}
