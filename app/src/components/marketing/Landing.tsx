import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Check, Database, KeyRound, TriangleAlert, GitFork } from 'lucide-react'
import { PLANS } from '@lovbase/core/plans'
import { useT } from '../../lib/i18n'
import { HeroVisual } from './HeroVisual'
import { HeroPrompt } from './HeroPrompt'
import { TemplatesGallery } from '../TemplatesGallery'
import { BillingToggle, PlanCards, type Billing } from './PricingCards'
import { Container, GITHUB_URL, hasGithub, MarketingFooter, MarketingHeader } from './MarketingChrome'

/**
 * One idea per screen, said plainly: what it is, the one thing it does that others do not, why
 * it is yours, then templates, price and a last nudge. Architecture words stay out of the copy —
 * the people this is for describe businesses, not schemas.
 */
export function Landing() {
  const [billing, setBilling] = useState<Billing>('monthly')
  const t = useT()

  return (
    <div className="mk min-h-screen bg-panel text-fg antialiased">
      <MarketingHeader />

      {/* ── Hero ── */}
      <section className="relative overflow-hidden">
        <Container className="pt-20 sm:pt-28 pb-16 sm:pb-20 text-center">
          <p className="text-[13px] text-fg-dim">
            {t('mk.hero.kicker', 'Open source · self-hostable · built on Postgres')}
          </p>
          <h1 className="font-serif text-[44px] sm:text-[72px] leading-[1.08] whitespace-pre-line mt-5 max-w-4xl mx-auto">
            {t('mk.hero.title', 'Turn an idea into\nan app that actually works')}
          </h1>
          <p className="text-[17px] sm:text-[19px] leading-[1.65] text-fg-mid mt-7 max-w-[42rem] mx-auto text-balance">
            {t('mk.hero.sub', 'Describe it in a sentence. Lovbase builds the database and the interface — and when you change your mind later, your data stays.')}
          </p>
          <div className="mt-10">
            <HeroPrompt />
          </div>
        </Container>
        <Container className="pb-24 sm:pb-28">
          <div className="max-w-5xl mx-auto">
            <HeroVisual />
          </div>
        </Container>
      </section>

      {/* ── The one difference ── */}
      <section id="features" className="scroll-mt-20 border-t border-edge">
        <Container className="py-24 sm:py-32 grid lg:grid-cols-[1fr_1.05fr] gap-14 lg:gap-20 items-center">
          <div>
            <h2 className="font-serif text-[36px] sm:text-[48px] leading-[1.15] whitespace-pre-line">
              {t('mk.change.title', 'Change your mind.\nKeep every row.')}
            </h2>
            <p className="text-[17px] leading-[1.75] text-fg-mid mt-6 max-w-[30rem]">
              {t('mk.change.body', 'Most AI builders rebuild the tables whenever the requirements change, and what you already entered goes with them. Lovbase works out exactly what changed: a rename stays a rename, a new field is just added. Anything that would delete data waits for you to confirm it.')}
            </p>
          </div>
          <ChangeCard />
        </Container>
      </section>

      {/* ── Yours ── */}
      <section className="border-t border-edge">
        <Container className="py-24 sm:py-28">
          <h2 className="font-serif text-[32px] sm:text-[40px] leading-[1.15] max-w-2xl text-balance">
            {t('mk.own.title', 'Not a demo. A system that is yours.')}
          </h2>
          <div className="grid md:grid-cols-3 gap-12 md:gap-10 mt-14">
            <Point icon={<Database />} title={t('mk.own.db.title', 'A real Postgres database')}
              body={t('mk.own.db.body', 'Every project gets its own database. psql, Metabase, your spreadsheet plugin — anything can connect to it directly.')} />
            <Point icon={<GitFork />} title={t('mk.own.oss.title', 'Open source, self-hostable')}
              body={t('mk.own.oss.body', 'All of it is on GitHub. One docker compose command runs it on your own server.')}
              link={hasGithub ? { href: GITHUB_URL, label: t('mk.own.oss.link', 'View on GitHub') } : undefined} />
            <Point icon={<KeyRound />} title={t('mk.own.byok.title', 'Your own model, if you want')}
              body={t('mk.own.byok.body', 'From Pro, connect your own model and key. Conversations on it use no credits.')} />
          </div>
        </Container>
      </section>

      {/* ── Templates ── */}
      <section id="templates" className="scroll-mt-20 border-t border-edge bg-panel-2/60">
        <Container className="py-20 sm:py-24">
          <TemplatesGallery signedIn={false} compact />
        </Container>
      </section>

      {/* ── Pricing ── */}
      <section className="border-t border-edge">
        <Container className="py-24 sm:py-28">
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
            <div className="max-w-xl">
              <h2 className="font-serif text-[32px] sm:text-[40px] leading-[1.15]">{t('mk.pricing.title', 'Start free. Pay for what you use.')}</h2>
              <p className="text-[16px] leading-[1.7] text-fg-mid mt-4">
                {t('mk.pricing.sub', 'Credits follow what each conversation actually costs. The free plan includes {free} a month — enough to build your first idea.')
                  .replace('{free}', String(PLANS.free.credits))}
              </p>
            </div>
            <BillingToggle value={billing} onChange={setBilling} />
          </div>
          <div className="mt-12">
            <PlanCards billing={billing} compact />
          </div>
          <Link to="/pricing" className="inline-flex items-center gap-1.5 mt-8 text-[14px] text-fg-mid hover:text-fg transition-colors">
            {t('landing.pricing.more', 'See the full comparison and FAQ')} <ArrowRight className="size-3.5" />
          </Link>
        </Container>
      </section>

      {/* ── Last nudge ── */}
      <section className="border-t border-edge">
        <Container className="py-28 sm:py-36 text-center">
          <h2 className="font-serif text-[38px] sm:text-[56px] leading-[1.12] whitespace-pre-line max-w-3xl mx-auto">
            {t('mk.cta.title', 'Build one table,\nthen decide whether to trust it.')}
          </h2>
          <p className="text-[17px] text-fg-mid mt-6 max-w-lg mx-auto text-balance">
            {t('mk.cta.sub', 'Sign up and start in a minute. If it is not for you, export your data and take it with you.')}
          </p>
          <Link to="/signup"
            className="inline-flex items-center gap-2 mt-10 h-12 px-6 rounded-full bg-fg text-panel text-[15px] font-medium hover:opacity-85 transition-opacity">
            {t('cta.startFree', 'Start free')} <ArrowRight className="size-4" />
          </Link>
        </Container>
      </section>

      <MarketingFooter />
    </div>
  )
}

function Point({ icon, title, body, link }: { icon: React.ReactNode; title: string; body: string; link?: { href: string; label: string } }) {
  return (
    <div>
      <span className="block text-fg [&_svg]:size-6 [&_svg]:stroke-[1.5]">{icon}</span>
      <h3 className="text-[18px] font-medium mt-5">{title}</h3>
      <p className="text-[15.5px] leading-[1.75] text-fg-mid mt-2.5">{body}</p>
      {link && (
        <a href={link.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 mt-3 text-[14px] text-fg hover:underline underline-offset-4">
          {link.label} <ArrowRight className="size-3.5" />
        </a>
      )}
    </div>
  )
}

/** What a change request looks like from the user's side: two applied, one waiting on them. */
function ChangeCard() {
  const t = useT()
  return (
    <div className="rounded-[22px] border border-edge bg-panel shadow-[0_1px_2px_rgba(30,25,15,.04),0_24px_48px_-24px_rgba(30,25,15,.18)] p-6 sm:p-8">
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl bg-panel-2 px-4 py-2.5 text-[15px] leading-6">
          {t('mk.change.ask', 'Rename "Clients" to "Customers", add a membership tier, and drop the fax number.')}
        </p>
      </div>
      <ul className="mt-6 space-y-4 text-[15px]">
        <li className="flex gap-3">
          <Check className="size-5 shrink-0 mt-0.5 text-ok" strokeWidth={2} />
          <div>
            <p>{t('mk.change.rename', 'Renamed Clients → Customers')}</p>
            <p className="text-[13.5px] text-fg-dim mt-0.5">{t('mk.change.renameKept', 'All 1,284 rows kept')}</p>
          </div>
        </li>
        <li className="flex gap-3">
          <Check className="size-5 shrink-0 mt-0.5 text-ok" strokeWidth={2} />
          <div>
            <p>{t('mk.change.add', 'Added field: Membership tier')}</p>
            <p className="text-[13.5px] text-fg-dim mt-0.5">{t('mk.change.addOptions', 'Standard · Silver · Gold')}</p>
          </div>
        </li>
        <li className="flex gap-3">
          <TriangleAlert className="size-5 shrink-0 mt-0.5 text-warn" strokeWidth={2} />
          <div className="flex-1">
            <p>{t('mk.change.drop', 'Delete field: Fax number')}</p>
            <p className="text-[13.5px] text-fg-dim mt-0.5">{t('mk.change.dropWait', 'This deletes data, so it waits for you')}</p>
            <div className="flex gap-2 mt-3">
              <span className="h-8 px-3.5 inline-flex items-center rounded-full bg-fg text-panel text-[13px] font-medium">{t('mk.change.confirm', 'Delete it')}</span>
              <span className="h-8 px-3.5 inline-flex items-center rounded-full border border-edge text-[13px] text-fg-mid">{t('mk.change.keep', 'Keep it')}</span>
            </div>
          </div>
        </li>
      </ul>
    </div>
  )
}
