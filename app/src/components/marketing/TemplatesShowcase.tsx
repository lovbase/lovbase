import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { listedTemplates } from '@lovbase/core/templates'
import { useI18n } from '../../lib/i18n'
import { Container } from './MarketingChrome'

/**
 * The listed built-ins, server-rendered as plain links: a visitor sees what Lovbase builds before
 * signing up, and a crawler reaches every template page from the front door.
 */
export function TemplatesShowcase() {
  const { locale, t } = useI18n()
  return (
    <section id="templates" className="scroll-mt-20 border-t border-edge bg-panel-2/60">
      <Container className="py-24 sm:py-28">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
          <div className="max-w-xl">
            <h2 className="font-serif text-[32px] sm:text-[40px] leading-[1.15]">
              {t('mk.templates.title', 'Or start from an app that already works')}
            </h2>
            <p className="text-[16px] leading-[1.7] text-fg-mid mt-4">
              {t('mk.templates.sub', 'Templates that are each a real Postgres database with sample data already in it. Open one, try it, then make it yours.')}
            </p>
          </div>
          <Link to="/templates" className="inline-flex items-center gap-1.5 text-[14px] text-fg-mid hover:text-fg transition-colors">
            {t('mk.templates.all', 'Browse all templates')} <ArrowRight className="size-3.5" />
          </Link>
        </div>
        <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-10 mt-12">
          {listedTemplates.map((template) => (
            <li key={template.id}>
              <Link to="/templates/$templateId" params={{ templateId: template.id }}
                className="group block rounded-2xl focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-4">
                <div className="overflow-hidden rounded-2xl border border-edge bg-panel aspect-[1.65] shadow-sm">
                  <img src={template.cover} alt={template.name[locale]} loading="lazy"
                    className="w-full h-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.025]" />
                </div>
                <p className="eyebrow uppercase tracking-[.14em] mt-4">{template.category[locale]}</p>
                <h3 className="text-[17px] font-medium mt-1.5 group-hover:text-accent transition-colors">{template.name[locale]}</h3>
                <p className="text-[14.5px] leading-[1.65] text-fg-mid mt-1.5">{template.description[locale]}</p>
              </Link>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  )
}
