import { useState } from 'react'
import { Check, ChevronDown, Minus } from 'lucide-react'
import { CREDIT_PACKS, PLANS, PLAN_IDS, type Plan } from '@lovbase/core/plans'
import { useT } from '../../lib/i18n'
import { BillingToggle, PlanCards, fmtStorage, yearlySavingPct, type Billing, type Viewer } from './PricingCards'
import { Container, GITHUB_URL, hasGithub, MarketingFooter, MarketingHeader, PrimaryLink, SectionHead } from './MarketingChrome'

type T = ReturnType<typeof useT>
type Cell = string | boolean
type Row = { label: string; note?: string; values: Record<Plan, Cell> }

// Numbers come from plans.ts so they can never drift; the capability rows restate that file's
// feature lists in a comparable shape.
const compareRows = (t: T): Row[] => [
  { label: t('pricing.compare.credits', 'Agent credits per month'), values: rec((p) => t('pricing.compare.credits.value', '{n} credits').replace('{n}', String(PLANS[p].credits))) },
  { label: t('pricing.compare.projects', 'Projects'), values: rec((p) => t('pricing.compare.projects.value', '{n}').replace('{n}', String(PLANS[p].projects))) },
  { label: t('pricing.compare.storage', 'Data storage'), values: rec((p) => fmtStorage(PLANS[p].storageMb)) },
  { label: t('pricing.compare.tables', 'Real Postgres tables'), values: { free: true, pro: true, business: true } },
  { label: t('pricing.compare.api', 'Data API (REST)'), values: { free: true, pro: true, business: true } },
  { label: t('pricing.compare.share', 'Public share links'), values: { free: true, pro: true, business: true } },
  { label: t('pricing.compare.byok', 'BYOK: your own model and key'), values: { free: false, pro: PLANS.pro.byok, business: PLANS.business.byok } },
  { label: t('pricing.compare.direct', 'Direct database connection'), note: t('pricing.compare.direct.note', 'Connection string for a read-only account'), values: { free: false, pro: true, business: true } },
  { label: t('pricing.compare.export', 'Export SQL and project source'), values: { free: false, pro: true, business: true } },
  { label: t('pricing.compare.domain', 'Publish on a custom domain'), values: { free: false, pro: true, business: true } },
  { label: t('pricing.compare.queue', 'Priority generation queue'), values: { free: false, pro: true, business: true } },
  { label: t('pricing.compare.instance', 'Dedicated database instance'), values: { free: false, pro: false, business: true } },
  { label: t('pricing.compare.deploy', 'Assisted private deployment'), note: t('pricing.compare.deploy.note', 'Self-hosting it yourself is open to everyone; this is us helping you deploy'), values: { free: false, pro: false, business: true } },
  { label: t('pricing.compare.sso', 'SSO and audit logs'), values: { free: false, pro: false, business: true } },
  {
    label: t('pricing.compare.support', 'Support'),
    values: {
      free: t('pricing.compare.support.free', 'Community'),
      pro: t('pricing.compare.support.pro', 'Email support'),
      business: t('pricing.compare.support.business', 'Dedicated support'),
    },
  },
]

function rec(f: (p: Plan) => string): Record<Plan, Cell> {
  return { free: f('free'), pro: f('pro'), business: f('business') }
}

const faq = (t: T): { q: string; a: string }[] => [
  {
    q: t('pricing.faq.credit.q', 'What exactly is one credit?'),
    a: t('pricing.faq.credit.a', 'Credits are metered against real usage: what a turn costs depends on the model tier and the tokens it actually spent. A short question costs a few; having the agent read through your code and change three tables costs more. Every charge is itemised under Settings → Usage, down to which model and how many tokens. Turns on your own key (BYOK) cost nothing.'),
  },
  {
    q: t('pricing.faq.outOfCredits.q', 'What happens when I run out of credits?'),
    a: t('pricing.faq.outOfCredits.a', 'The databases, tables and data you have already built are untouched, apps keep serving, and the data API keeps reading and writing. Credits only gate putting the agent back to work. They reset at the start of each billing period: {free} a month on Free, {pro} on Pro and {business} on Business. Upgrade to keep going, or wait for the next period.')
      .replace('{free}', String(PLANS.free.credits))
      .replace('{pro}', String(PLANS.pro.credits))
      .replace('{business}', String(PLANS.business.credits)),
  },
  {
    q: t('pricing.faq.ownership.q', 'Who actually owns the data?'),
    a: t('pricing.faq.ownership.a', 'You do. Every project is its own Postgres schema, and paid plans hand you the connection string, so any Postgres client can connect. You can export the whole thing as SQL at any time, without going through our UI. We also never train models on your business data.'),
  },
  {
    q: t('pricing.faq.safety.q', 'Can the AI drop my tables?'),
    a: t('pricing.faq.safety.a', 'The model never changes structure directly. It only emits IR with stable IDs; deterministic code computes the diff and compiles it into whitelisted DDL. Renaming a field is recognized as a RENAME rather than a drop and recreate. Destructive changes such as dropping a table or a column or changing a type stop and wait for you to confirm them in the UI.'),
  },
  {
    q: t('pricing.faq.selfhost.q', 'Can I self-host it?'),
    a: t('pricing.faq.selfhost.a', 'Lovbase is open source and runs entirely on your own machines: docker compose for Postgres, the main app started locally, and the sandbox runner that executes generated code on your own Docker host. Self-hosting needs no paid plan; the "assisted private deployment" in Business means we help you deploy and maintain it.'),
  },
  {
    q: t('pricing.faq.byok.q', 'Can I use my own model key?'),
    a: t('pricing.faq.byok.a', 'Yes, on Pro and above. Put any OpenAI-compatible endpoint and key on the account page; the key is stored AES-GCM encrypted, and inference then runs on your own model and your own bill, including a model you host on your own network. Free uses the model the platform configures. Note that credits still count: we are still running the sandbox and the database.'),
  },
  {
    q: t('pricing.faq.refund.q', 'How do refunds work?'),
    a: t('pricing.faq.refund.a', 'A monthly subscription can be cancelled at any time; you keep access for the current period and are not billed again. If an annual plan turns out not to fit, contact us and we will refund the unused months.'),
  },
]

export function PricingView({ viewer }: { viewer?: Viewer }) {
  const [billing, setBilling] = useState<Billing>('monthly')
  const t = useT()
  const pct = yearlySavingPct()
  const ROWS = compareRows(t)
  const FAQ = faq(t)

  return (
    <div className="min-h-screen bg-panel text-fg antialiased">
      <MarketingHeader signedIn={viewer?.signedIn} />

      <section className="hero-wash border-b border-edge">
        <Container className="pt-16 sm:pt-20 pb-14 text-center">
          <p className="eyebrow uppercase tracking-[.14em]">{t('nav.pricing', 'Pricing')}</p>
          <h1 className="font-display text-[34px] sm:text-[46px] font-semibold leading-[1.1] tracking-tight text-balance mt-3">
            {t('pricing.hero.title', 'Pay for what you use, not per head')}
          </h1>
          <p className="text-[15px] leading-relaxed text-fg-mid mt-4 max-w-xl mx-auto text-balance">
            {t('pricing.hero.sub', 'Credits are metered against what each turn actually costs. Your databases, tables and finished apps keep running even when credits run out.')}
          </p>
          <div className="mt-8 flex justify-center">
            <BillingToggle value={billing} onChange={setBilling} />
          </div>
        </Container>
      </section>

      <section className="py-14 sm:py-16">
        <Container>
          <PlanCards billing={billing} viewer={viewer} />
          <p className="text-[12.5px] text-fg-dim mt-6 text-center">
            {t('pricing.note.currency', 'Prices in USD. ')}
            {pct > 0
              ? t('pricing.note.yearly', 'Billed yearly that works out to ${price} a month (Pro), {pct}% less than monthly. ')
                  .replace('{price}', String(PLANS.pro.yearlyPrice))
                  .replace('{pct}', String(pct))
              : ''}
            {t('pricing.note.selfhost', 'Self-hosting is always free.')}
          </p>
        </Container>
      </section>

      {/* ── Credits explainer ── */}
      <section className="py-16 border-t border-edge">
        <Container>
          <SectionHead
            eyebrow={t('pricing.credits.eyebrow', 'Credits')}
            title={t('pricing.credits.title', 'Every charge, itemised')}
            sub={t('pricing.credits.sub', 'Priced against real cost, not against a vague unit like a "premium request". Every charge shows the model and the tokens behind it.')}
            className="mx-auto text-center max-w-2xl [&>p]:mx-auto"
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-10">
            <CreditCard value={t('pricing.credits.metered', 'Metered')}
              title={t('pricing.credits.turn.title', 'One agent turn')}
              body={t('pricing.credits.turn.body', 'Charged on the tokens the turn actually spent and the tier of the model behind it, itemised afterwards.')} />
            <CreditCard value={t('pricing.credits.metered', 'Metered')}
              title={t('pricing.credits.build.title', 'One generated interface')}
              body={t('pricing.credits.build.body', 'Boris writes and runs the whole frontend inside a container, and the container time counts too, so it costs more.')} />
            <CreditCard value="0" unit={t('pricing.credits.unit', 'credits')}
              title={t('pricing.credits.free.title', 'Using what you already built')}
              body={t('pricing.credits.free.body', 'Reading and writing data, opening the app, connecting to the database and calling the data API all cost nothing.')} />
          </div>
          {/* Packs, right under what a credit is: the question "what if I run out" arrives here,
              and the answer used to be "subscribe to the next tier up" whether or not that fit. */}
          <div className="mt-10 rounded-2xl border border-edge p-6 sm:p-7">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <p className="text-[14px] font-medium">{t('pricing.packs.title', 'Out of credits? Buy a pack')}</p>
              <p className="text-[12.5px] text-fg-dim">{t('pricing.packs.sub', 'A one-off payment. Bought credits do not expire with the period, and are only spent once the plan\u2019s monthly allowance is gone.')}</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-5">
              {CREDIT_PACKS.map((p) => (
                <div key={p.id} className="rounded-xl border border-edge px-5 py-4">
                  <p className="text-[22px] font-semibold tabular-nums leading-none">
                    {p.credits}<span className="text-[12px] text-fg-dim font-normal"> {t('pricing.credits.unit', 'credits')}</span>
                  </p>
                  <p className="text-[12.5px] text-fg-dim mt-2 tabular-nums">${p.price} · ${(p.price / p.credits).toFixed(3)} / credit</p>
                </div>
              ))}
            </div>
          </div>
        </Container>
      </section>

      {/* ── Comparison ── */}
      <section className="py-16 border-t border-edge">
        <Container>
          <SectionHead eyebrow={t('pricing.compare.eyebrow', 'Compare')} title={t('pricing.compare.title', 'What each of the three plans includes')} />
          <div className="mt-8 overflow-x-auto rounded-2xl border border-edge bg-panel">
            <table className="w-full min-w-[36rem] text-left border-collapse">
              <thead>
                <tr className="border-b border-edge">
                  <th className="font-normal text-[12.5px] text-fg-dim px-5 py-3.5 w-[38%]">{t('pricing.compare.head', 'Feature')}</th>
                  {PLAN_IDS.map((p) => (
                    <th key={p} className="px-5 py-3.5">
                      <span className="text-[13.5px] font-medium text-fg">{PLANS[p].name}</span>
                      {PLANS[p].featured && <span className="ml-2 font-mono text-[10.5px] text-fg-dim">{t('pricing.compare.recommended', 'Recommended')}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r.label} className="border-b border-edge last:border-b-0">
                    <th scope="row" className="font-normal px-5 py-3.5 align-top">
                      <span className="text-[13.5px] text-fg-mid">{r.label}</span>
                      {r.note && <span className="block text-[11.5px] text-fg-dim mt-0.5">{r.note}</span>}
                    </th>
                    {PLAN_IDS.map((p) => (
                      <td key={p} className="px-5 py-3.5 align-top">
                        {typeof r.values[p] === 'boolean'
                          ? (r.values[p] ? <Check className="size-4 text-fg" strokeWidth={2.5} /> : <Minus className="size-4 text-fg-dim/60" />)
                          : <span className="text-[13.5px] text-fg-mid">{r.values[p] as string}</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Container>
      </section>

      {/* ── FAQ ── */}
      <section className="py-16 border-t border-edge">
        <Container>
          <div className="grid lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] gap-10">
            <div>
              <SectionHead eyebrow={t('pricing.faq.eyebrow', 'FAQ')} title={t('pricing.faq.title', 'What you are probably wondering')} />
              <p className="text-[13px] text-fg-dim mt-5">
                {t('pricing.faq.more.before', 'Anything else?')}{' '}
                {hasGithub && (<a href={GITHUB_URL} target="_blank" rel="noreferrer" className="text-fg-mid hover:text-fg underline underline-offset-4 decoration-edge-strong">
                  GitHub
                </a>)}{' '}
                {t('pricing.faq.more.after', 'Open an issue.')}
              </p>
            </div>
            <div className="rounded-2xl border border-edge bg-panel divide-y divide-edge overflow-hidden">
              {FAQ.map((f) => (
                <details key={f.q} className="group">
                  <summary className="flex items-center justify-between gap-4 px-5 sm:px-6 py-4 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                    <span className="text-[14px] font-medium text-fg">{f.q}</span>
                    <ChevronDown className="size-4 shrink-0 text-fg-dim transition-transform group-open:rotate-180" />
                  </summary>
                  <p className="px-5 sm:px-6 pb-5 -mt-1 text-[13.5px] leading-relaxed text-fg-mid max-w-2xl">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </Container>
      </section>

      <section className="border-t border-edge bg-panel-2">
        <Container className="py-20 text-center">
          <h2 className="font-display text-[26px] sm:text-[32px] font-semibold leading-tight text-balance">
            {t('pricing.cta.title', 'The free plan already builds a real database')}
          </h2>
          <p className="text-[14px] text-fg-mid mt-4">
            {t('pricing.cta.sub', 'Spend the {n} free credits getting the idea built, then decide.').replace('{n}', String(PLANS.free.credits))}
          </p>
          <div className="mt-8 flex justify-center">
            <PrimaryLink to="/signup">{t('cta.startFree', 'Start free')}</PrimaryLink>
          </div>
        </Container>
      </section>

      <MarketingFooter />
    </div>
  )
}

function CreditCard({ value, unit, title, body }: { value: string; unit?: string; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-edge bg-panel p-6">
      <p className="font-display text-[30px] font-semibold leading-none tracking-tight">
        {value}
        {unit ? <span className="text-[13px] font-normal text-fg-dim ml-1.5">{unit}</span> : null}
      </p>
      <h3 className="text-[14.5px] font-medium mt-4">{title}</h3>
      <p className="text-[13px] leading-relaxed text-fg-dim mt-1.5">{body}</p>
    </div>
  )
}
