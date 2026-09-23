import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowRight, Bot, Database, Globe, KeyRound, MessageSquareText, Server, ShieldCheck,
} from 'lucide-react'
import { PLANS } from '@lovbase/core/plans'
import { useT } from '../../lib/i18n'
import { ApiSection } from './ApiSection'
import { HeroVisual } from './HeroVisual'
import { BillingToggle, PlanCards, type Billing } from './PricingCards'
import { Container, GhostLink, GITHUB_URL, hasGithub, MarketingFooter, MarketingHeader, PrimaryLink, SectionHead } from './MarketingChrome'

type T = ReturnType<typeof useT>

const steps = (t: T) => [
  {
    icon: MessageSquareText,
    title: t('landing.steps.describe.title', 'You describe what you need'),
    body: t('landing.steps.describe.body', 'Explain the business in plain language: customers, orders, follow-ups. No need to settle on fields or draw tables first.'),
  },
  {
    icon: Database,
    title: t('landing.steps.schema.title', 'It designs a real schema'),
    body: t('landing.steps.schema.body', 'The model emits IR with stable IDs, deterministic code compiles that into DDL, and real tables appear in your Postgres.'),
  },
  {
    icon: Bot,
    title: t('landing.steps.build.title', 'Boris writes the interface'),
    body: t('landing.steps.build.body', 'Boris, the coding agent, writes a React frontend in a sandbox container that reads and writes the tables you just created. It is clickable the moment it lands.'),
  },
  {
    icon: Globe,
    title: t('landing.steps.ship.title', 'Publish, then keep changing it'),
    body: t('landing.steps.ship.body', 'Publish a share link in one click. Change the requirements later and a rename is a RENAME, not a drop and recreate: not a row of existing data is lost.'),
  },
]

const features = (t: T) => [
  {
    icon: Database,
    title: t('landing.features.db.title', 'A real Postgres database'),
    body: t('landing.features.db.body', 'Not a toy built-in store, and not a CSV export. Every project gets its own schema and a connection string, so psql, DBeaver, Metabase and Prisma connect straight to it.'),
    points: [
      t('landing.features.db.p1', 'Own schema + restricted role'),
      t('landing.features.db.p2', 'Export SQL anytime'),
      t('landing.features.db.p3', 'REST data API'),
    ],
  },
  {
    icon: ShieldCheck,
    title: t('landing.features.safe.title', 'The AI cannot delete your data'),
    body: t('landing.features.safe.body', 'The LLM never writes SQL. It only emits IR; a deterministic diff works out the change and compiles it into whitelisted DDL. Dropping a table or a column, or changing a type, has to be confirmed by you in the UI.'),
    points: [
      t('landing.features.safe.p1', 'IR → diff → whitelisted DDL'),
      t('landing.features.safe.p2', 'Renames detected as RENAME'),
      t('landing.features.safe.p3', 'Destructive changes need confirmation'),
    ],
  },
  {
    icon: Server,
    title: t('landing.features.selfhost.title', 'Fully self-hostable'),
    body: t('landing.features.selfhost.body', 'The database, the main app and the sandbox that runs the code can all live on your own machines. docker compose brings up Postgres; the sandbox runner gives each app its own container on any Docker host.'),
    points: [
      t('landing.features.selfhost.p1', 'docker compose for local'),
      t('landing.features.selfhost.p2', 'Self-hosted sandbox runner'),
      t('landing.features.selfhost.p3', 'Previews on your own domain'),
    ],
  },
  {
    icon: KeyRound,
    title: t('landing.features.byok.title', 'BYOK: bring your own model'),
    body: t('landing.features.byok.body', 'From Pro up, point Lovbase at your own OpenAI-compatible endpoint and key, stored AES-GCM encrypted. Your model and your bill, including a model you host on your own network.'),
    points: [
      t('landing.features.byok.p1', 'OpenAI-compatible endpoint'),
      t('landing.features.byok.p2', 'Keys stored encrypted'),
      t('landing.features.byok.p3', 'Pro and above'),
    ],
  },
]

const openFacts = (t: T) => [
  { k: t('landing.open.code.k', 'The whole codebase is readable'), v: t('landing.open.code.v', 'The engine, the SQL gateway and the sandbox runner are all in the repo. It is not just an open SDK.') },
  { k: t('landing.open.local.k', 'It runs on your machine'), v: t('landing.open.local.v', 'docker compose for Postgres, bun run dev, and that is the full product.') },
  { k: t('landing.open.data.k', 'The data lives in your database'), v: t('landing.open.data.v', 'When you self-host, the connection string is yours and we cannot reach it.') },
  { k: t('landing.open.model.k', 'The model is swappable'), v: t('landing.open.model.v', 'Self-hosted, you configure the model endpoint yourself; on the hosted version, BYOK from Pro up.') },
]

const selfHostLines = (t: T) => [
  'git clone <repo> && cd lovbase',
  'docker compose up -d          # Postgres',
  t('landing.selfhost.line.env', 'cp .env.example app/.dev.vars # LLM key, or use BYOK'),
  'bun install && bun run dev    # localhost:3008',
]

export function Landing() {
  const [billing, setBilling] = useState<Billing>('monthly')
  const t = useT()
  const STEPS = steps(t)
  const FEATURES = features(t)
  const OPEN_FACTS = openFacts(t)
  const SELF_HOST_LINES = selfHostLines(t)

  return (
    <div className="min-h-screen bg-panel text-fg antialiased">
      <MarketingHeader />

      {/* ── Hero ── */}
      <section className="hero-wash border-b border-edge">
        <Container className="pt-16 sm:pt-24 pb-14 sm:pb-20">
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-panel border border-edge text-[12px] text-fg-mid">
              <span className="size-1.5 rounded-full bg-ok" />
              {t('landing.hero.badge', 'The open-source Lovable alternative · built on your own Postgres')}
            </div>
            <h1 className="font-display text-[38px] sm:text-[56px] font-semibold leading-[1.08] tracking-tight text-balance mt-6">
              {t('landing.hero.title.a', 'Describe it once.')}
              <br className="hidden sm:block" />
              {t('landing.hero.title.b', 'Get a real database and an app.')}
            </h1>
            <p className="text-[15px] sm:text-[16.5px] leading-relaxed text-fg-mid mt-5 max-w-xl mx-auto text-balance">
              {t('landing.hero.sub', 'AI designs the Postgres schema, Boris writes the app. The database is yours to connect to directly.')}
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-8">
              <PrimaryLink to="/signup" className="w-full sm:w-auto">
                {t('nav.start', 'Start building')} <ArrowRight className="size-4" />
              </PrimaryLink>
              <GhostLink to="/pricing" className="w-full sm:w-auto">{t('landing.hero.seePricing', 'See pricing')}</GhostLink>
            </div>
            <p className="text-[12.5px] text-fg-dim mt-4">
              {t('landing.hero.note', 'Free to start · {credits} credits a month, metered by usage · no credit card').replace('{credits}', String(PLANS.free.credits))}
            </p>
          </div>

          <div className="mt-14 sm:mt-16 max-w-5xl mx-auto">
            <HeroVisual />
          </div>
        </Container>
      </section>

      {/* ── How it works ── */}
      <section id="how" className="scroll-mt-20 py-20 sm:py-24">
        <Container>
          <SectionHead
            eyebrow={t('landing.how.eyebrow', 'How it works')}
            title={t('landing.how.title', 'From one sentence to a live app, in four steps')}
            sub={t('landing.how.sub', 'There is no "export it and wire up a database yourself" step in the middle. The database is real from the first step.')}
          />
          <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px mt-10 rounded-2xl overflow-hidden border border-edge bg-edge">
            {STEPS.map((s, i) => (
              <li key={s.title} className="bg-panel p-6 flex flex-col">
                <div className="flex items-center justify-between">
                  <span className="size-8 rounded-lg border border-edge bg-panel-2 flex items-center justify-center">
                    <s.icon className="size-4 text-fg-mid" strokeWidth={1.75} />
                  </span>
                  <span className="font-mono text-[11px] text-fg-dim">0{i + 1}</span>
                </div>
                <h3 className="text-[14.5px] font-medium mt-4">{s.title}</h3>
                <p className="text-[13px] leading-relaxed text-fg-dim mt-2">{s.body}</p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      {/* ── Features ── */}
      <section id="features" className="scroll-mt-20 py-20 sm:py-24 border-t border-edge">
        <Container>
          <SectionHead
            eyebrow={t('landing.features.eyebrow', 'Why it is different')}
            title={t('landing.features.title', 'Other tools hand you a demo. Lovbase hands you infrastructure.')}
            sub={t('landing.features.sub', 'Generating an interface is something everyone can do. The difference is whether what comes out still belongs to you.')}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-10">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-2xl border border-edge bg-panel p-6 sm:p-7 hover:border-edge-strong transition-colors">
                <span className="size-9 rounded-xl border border-edge bg-panel-2 flex items-center justify-center">
                  <f.icon className="size-4.5 text-fg-mid" strokeWidth={1.75} />
                </span>
                <h3 className="font-display text-[17px] font-semibold mt-4">{f.title}</h3>
                <p className="text-[13.5px] leading-relaxed text-fg-mid mt-2.5">{f.body}</p>
                <ul className="flex flex-wrap gap-1.5 mt-4">
                  {f.points.map((p) => (
                    <li key={p} className="px-2 py-0.5 rounded-md border border-edge bg-panel-2 font-mono text-[11px] text-fg-dim">
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <ApiSection />

      {/* ── Open source / self-host. Honest framing: facts you can check, not logos we don't have. ── */}
      <section id="selfhost" className="scroll-mt-20 py-20 sm:py-24 border-t border-edge bg-panel-2">
        <Container>
          <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-start">
            <div>
              <SectionHead
                eyebrow={t('landing.open.eyebrow', 'Open source, self-hosted')}
                title={t('landing.open.title', 'No logo wall, only facts you can check yourself')}
                sub={t('landing.open.sub', 'We are not going to line up avatars and numbers you have no way to verify. The more direct way to judge a data tool is to pull it down and run it yourself.')}
              />
              <div className="mt-7 rounded-xl border border-edge bg-panel overflow-hidden">
                <div className="px-4 py-2 border-b border-edge flex items-center justify-between">
                  <span className="font-mono text-[11px] text-fg-dim">{t('landing.open.runLocally', 'Run it locally')}</span>
                  {hasGithub && (<a href={GITHUB_URL} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-fg-mid hover:text-fg transition-colors">
                    GitHub ↗
                  </a>)}
                </div>
                <pre className="px-4 py-3.5 overflow-x-auto font-mono text-[12px] leading-[1.85] text-fg-mid">
                  <code>{SELF_HOST_LINES.join('\n')}</code>
                </pre>
              </div>
            </div>

            <dl className="rounded-2xl border border-edge bg-panel divide-y divide-edge overflow-hidden">
              {OPEN_FACTS.map((f) => (
                <div key={f.k} className="p-5 sm:p-6">
                  <dt className="text-[14px] font-medium">{f.k}</dt>
                  <dd className="text-[13px] leading-relaxed text-fg-dim mt-1.5">{f.v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Container>
      </section>

      {/* ── Pricing teaser ── */}
      <section className="py-20 sm:py-24 border-t border-edge">
        <Container>
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
            <SectionHead
              eyebrow={t('nav.pricing', 'Pricing')}
              title={t('landing.pricing.title', 'Priced per usage, not per seat')}
              sub={t('landing.pricing.sub', 'Credits are metered against what each turn actually costs, and your own model key costs nothing. Free gives you {free} a month, enough to get an idea built.')
                .replace('{free}', String(PLANS.free.credits))}
            />
            <BillingToggle value={billing} onChange={setBilling} />
          </div>
          <div className="mt-10">
            <PlanCards billing={billing} compact />
          </div>
          <div className="mt-8">
            <Link to="/pricing" className="inline-flex items-center gap-1.5 text-[13.5px] text-fg-mid hover:text-fg transition-colors">
              {t('landing.pricing.more', 'See the full comparison and FAQ')} <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </Container>
      </section>

      {/* ── Final CTA ── */}
      <section className="border-t border-edge bg-panel-2">
        <Container className="py-20 text-center">
          <h2 className="font-display text-[28px] sm:text-[36px] font-semibold leading-tight text-balance">
            {t('landing.cta.title', 'Create one table before you decide whether to trust it')}
          </h2>
          <p className="text-[14.5px] text-fg-mid mt-4 max-w-lg mx-auto">
            {t('landing.cta.sub', 'Sign up, create a project, and get the connection string immediately. If it is not for you, export the data and take it with you.')}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-8">
            <PrimaryLink to="/signup" className="w-full sm:w-auto">
              {t('cta.startFree', 'Start free')} <ArrowRight className="size-4" />
            </PrimaryLink>
            <GhostLink to="/pricing" className="w-full sm:w-auto">{t('landing.cta.pricing', 'Check the pricing')}</GhostLink>
          </div>
        </Container>
      </section>

      <MarketingFooter />
    </div>
  )
}
