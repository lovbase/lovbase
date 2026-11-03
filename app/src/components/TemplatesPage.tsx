import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Check, Play } from 'lucide-react'
import type { Template } from '@lovbase/core/templates'
import { useI18n } from '../lib/i18n'
import { TemplatesGallery } from './TemplatesGallery'
import { Container, MarketingFooter, MarketingHeader } from './marketing/MarketingChrome'

/**
 * The gallery page and each template's own page share this shell. A template page puts the
 * template above the gallery — name, description and cover in the server-rendered HTML — and
 * opens its demo straight away.
 */
export function TemplatesPage({
  signedIn,
  template,
  remix,
  community,
}: {
  signedIn: boolean
  template?: Template
  remix?: boolean
  community?: string
}) {
  const [openSignal, setOpenSignal] = useState(0)
  return (
    <div className="mk min-h-screen bg-panel text-fg antialiased">
      <MarketingHeader signedIn={signedIn} />
      <main>
        <Container className="py-12 sm:py-16">
          {template && <TemplateIntro template={template} onOpen={() => setOpenSignal((n) => n + 1)} />}
          <TemplatesGallery
            signedIn={signedIn}
            titleAs={template ? 'h2' : 'h1'}
            initialTemplate={template?.id}
            initialRemix={remix}
            initialCommunity={community}
            openSignal={openSignal}
          />
        </Container>
      </main>
      <MarketingFooter />
    </div>
  )
}

function TemplateIntro({ template, onOpen }: { template: Template; onOpen: () => void }) {
  const { locale, t } = useI18n()
  const name = template.name[locale]
  return (
    <section className="grid lg:grid-cols-[1fr_1.2fr] gap-8 lg:gap-14 items-center pb-14 sm:pb-16 mb-14 border-b border-edge">
      <div>
        <p className="eyebrow uppercase tracking-[.14em]">
          <Link to="/templates" className="hover:text-fg transition-colors">{t('tpl.page.kicker', 'Templates')}</Link>
          {' · '}
          {template.category[locale]}
        </p>
        <h1 className="font-serif text-[36px] sm:text-[48px] leading-[1.12] mt-3">{name}</h1>
        <p className="text-[17px] leading-[1.7] text-fg-mid mt-5 max-w-[32rem]">{template.description[locale]}</p>
        <ul className="mt-6 space-y-2.5 max-w-[32rem]">
          {template.highlights[locale].map((line) => (
            <li key={line} className="flex gap-3 text-[15px] leading-[1.6]">
              <Check className="size-5 shrink-0 mt-0.5 text-ok" strokeWidth={2} />
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <p className="text-[14.5px] leading-[1.7] text-fg-dim mt-5 max-w-[32rem]">
          {t('tpl.page.note', 'A working app on its own Postgres database, with sample data already in it. Try it here, then remix it into a project of your own.')}
        </p>
        <div className="flex flex-wrap items-center gap-4 mt-8">
          <button type="button" onClick={onOpen}
            className="inline-flex items-center gap-2 h-11 px-5 rounded-full bg-fg text-panel text-[14.5px] font-medium hover:opacity-85 transition-opacity cursor-pointer">
            <Play className="size-4" /> {t('tpl.page.open', 'Open the demo')}
          </button>
          <Link to="/templates" className="inline-flex items-center gap-1.5 text-[14px] text-fg-mid hover:text-fg transition-colors">
            {t('tpl.page.all', 'All templates')} <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </div>
      <button type="button" onClick={onOpen}
        className="group overflow-hidden rounded-[22px] border border-edge bg-panel-2 aspect-[1.65] shadow-sm cursor-pointer focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-4">
        <img src={template.cover} alt={name}
          className="w-full h-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.02]" />
      </button>
    </section>
  )
}
