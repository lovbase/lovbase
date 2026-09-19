import { useState } from 'react'
import { Check, ChevronDown, Minus } from 'lucide-react'
import { PLANS, PLAN_IDS, type Plan } from '@lovbase/core/plans'
import { useT } from '../../lib/i18n'
import { BillingToggle, PlanCards, fmtStorage, yearlySavingPct, type Billing } from './PricingCards'
import { Container, GITHUB_URL, hasGithub, MarketingFooter, MarketingHeader, PrimaryLink, SectionHead } from './MarketingChrome'

type T = ReturnType<typeof useT>
type Cell = string | boolean
type Row = { label: string; note?: string; values: Record<Plan, Cell> }

// Numbers come from plans.ts so they can never drift; the capability rows restate that file's
// feature lists in a comparable shape.
const compareRows = (t: T): Row[] => [
  { label: t('pricing.compare.credits', '每月对话额度'), values: rec((p) => t('pricing.compare.credits.value', '{n} credits').replace('{n}', String(PLANS[p].credits))) },
  { label: t('pricing.compare.projects', '项目数'), values: rec((p) => t('pricing.compare.projects.value', '{n} 个').replace('{n}', String(PLANS[p].projects))) },
  { label: t('pricing.compare.storage', '数据存储'), values: rec((p) => fmtStorage(PLANS[p].storageMb)) },
  { label: t('pricing.compare.tables', '真实 Postgres 表'), values: { free: true, pro: true, business: true } },
  { label: t('pricing.compare.api', '数据 API(REST)'), values: { free: true, pro: true, business: true } },
  { label: t('pricing.compare.share', '公开分享链接'), values: { free: true, pro: true, business: true } },
  { label: t('pricing.compare.byok', 'BYOK:自带模型与 key'), values: { free: false, pro: PLANS.pro.byok, business: PLANS.business.byok } },
  { label: t('pricing.compare.direct', '数据库直连'), note: t('pricing.compare.direct.note', '只读账号的连接串'), values: { free: false, pro: true, business: true } },
  { label: t('pricing.compare.export', '导出 SQL 与项目源码'), values: { free: false, pro: true, business: true } },
  { label: t('pricing.compare.domain', '自定义域名发布'), values: { free: false, pro: true, business: true } },
  { label: t('pricing.compare.queue', '优先生成队列'), values: { free: false, pro: true, business: true } },
  { label: t('pricing.compare.instance', '独立数据库实例'), values: { free: false, pro: false, business: true } },
  { label: t('pricing.compare.deploy', '私有化部署支持'), note: t('pricing.compare.deploy.note', '自己动手自托管对所有人开放;这里指由我们协助部署'), values: { free: false, pro: false, business: true } },
  { label: t('pricing.compare.sso', 'SSO 与审计日志'), values: { free: false, pro: false, business: true } },
  {
    label: t('pricing.compare.support', '支持方式'),
    values: {
      free: t('pricing.compare.support.free', '社区'),
      pro: t('pricing.compare.support.pro', '邮件支持'),
      business: t('pricing.compare.support.business', '专属支持'),
    },
  },
]

function rec(f: (p: Plan) => string): Record<Plan, Cell> {
  return { free: f('free'), pro: f('pro'), business: f('business') }
}

const faq = (t: T): { q: string; a: string }[] => [
  {
    q: t('pricing.faq.credit.q', '一次 credit 到底是什么?'),
    a: t('pricing.faq.credit.a', '额度按实际用量扣:一次对话消耗多少,取决于模型档位和这轮实际用掉的 token。简单的一句问答通常只要几点,让 agent 翻遍代码再改三张表会更多。用量明细在「设置 → 用量」里逐条可查,包括每一次用了哪个模型、多少 token。自带模型(BYOK)的对话不扣额度。'),
  },
  {
    q: t('pricing.faq.outOfCredits.q', '额度用完了会怎样?'),
    a: t('pricing.faq.outOfCredits.a', '已经建好的数据库、表和数据完全不受影响,应用照常访问,数据 API 照常读写——额度只影响“再让 agent 干活”。额度在每个计费周期开始时重置,免费版每月 {free} 次,Pro {pro} 次,Business {business} 次。想继续用就升级套餐,或者等下个周期。')
      .replace('{free}', String(PLANS.free.credits))
      .replace('{pro}', String(PLANS.pro.credits))
      .replace('{business}', String(PLANS.business.credits)),
  },
  {
    q: t('pricing.faq.ownership.q', '数据到底归谁?'),
    a: t('pricing.faq.ownership.a', '归你。每个项目是一个独立的 Postgres schema,付费版给你连接串,任何 Postgres 客户端都能连。你可以随时导出整份 SQL 带走,不需要经过我们的界面。我们也不会拿你的业务数据去训练模型。'),
  },
  {
    q: t('pricing.faq.safety.q', 'AI 会不会把我的表删了?'),
    a: t('pricing.faq.safety.a', '结构不由模型直接改。模型只产出带稳定 ID 的 IR,确定性代码算出 diff,再编译成白名单内的 DDL。改字段名会被识别成 RENAME,而不是删了重建。删表、删列、改类型这类破坏性变更会停下来,等你在界面上确认。'),
  },
  {
    q: t('pricing.faq.selfhost.q', '可以自托管吗?'),
    a: t('pricing.faq.selfhost.a', 'Lovbase 是开源的,可以完整跑在你自己的机器上:docker compose 起 Postgres,主应用本地启动,跑生成代码的沙箱 runner 落在你自己的 Docker 主机上。自托管不需要付费套餐;Business 里的“私有化部署支持”指的是我们协助部署和维护。'),
  },
  {
    q: t('pricing.faq.byok.q', '能用我自己的模型 key 吗?'),
    a: t('pricing.faq.byok.a', '可以,Pro 及以上。在账户页填任意 OpenAI 兼容端点和 key,key 用 AES-GCM 加密存储,之后推理走你自己的账单和模型,也可以指向内网自部署的模型。免费版用平台统一配置的模型。注意额度照常计算——沙箱和数据库仍然是我们在跑。'),
  },
  {
    q: t('pricing.faq.refund.q', '怎么退款?'),
    a: t('pricing.faq.refund.a', '按月订阅可以随时取消,取消后当前周期继续可用,不再续费。按年付如果用下来不合适,联系我们按未使用的月份退款。'),
  },
]

export function PricingView() {
  const [billing, setBilling] = useState<Billing>('monthly')
  const t = useT()
  const pct = yearlySavingPct()
  const ROWS = compareRows(t)
  const FAQ = faq(t)

  return (
    <div className="min-h-screen bg-ink text-fg antialiased">
      <MarketingHeader />

      <section className="hero-wash border-b border-edge">
        <Container className="pt-16 sm:pt-20 pb-14 text-center">
          <p className="eyebrow uppercase tracking-[.14em]">{t('nav.pricing', '价格')}</p>
          <h1 className="font-display text-[34px] sm:text-[46px] font-semibold leading-[1.1] tracking-tight text-balance mt-3">
            {t('pricing.hero.title', '按用量付费,不按人头')}
          </h1>
          <p className="text-[15px] leading-relaxed text-fg-mid mt-4 max-w-xl mx-auto text-balance">
            {t('pricing.hero.sub', '额度按每一轮实际用掉的成本扣。数据库、表和已经建好的应用不会因为额度用完而停掉。')}
          </p>
          <div className="mt-8 flex justify-center">
            <BillingToggle value={billing} onChange={setBilling} />
          </div>
        </Container>
      </section>

      <section className="py-14 sm:py-16">
        <Container>
          <PlanCards billing={billing} />
          <p className="text-[12.5px] text-fg-dim mt-6 text-center">
            {t('pricing.note.currency', '价格为美元。')}
            {pct > 0
              ? t('pricing.note.yearly', '按年付相当于每月 ${price}(Pro),比按月付省 {pct}%。')
                  .replace('{price}', String(PLANS.pro.yearlyPrice))
                  .replace('{pct}', String(pct))
              : ''}
            {t('pricing.note.selfhost', '自托管始终免费。')}
          </p>
        </Container>
      </section>

      {/* ── Credits explainer ── */}
      <section className="py-16 border-t border-edge">
        <Container>
          <SectionHead
            eyebrow={t('pricing.credits.eyebrow', '额度')}
            title={t('pricing.credits.title', '花了多少,逐条看得见')}
            sub={t('pricing.credits.sub', '按真实成本计,不按“高级请求”这种说不清的单位。每一条都能看到用了哪个模型、多少 token。')}
            className="mx-auto text-center max-w-2xl [&>p]:mx-auto"
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-10">
            <CreditCard value={t('pricing.credits.metered', '按量')}
              title={t('pricing.credits.turn.title', '一次对话')}
              body={t('pricing.credits.turn.body', '按这轮实际用掉的 token 和模型档位计,明细逐条可查。')} />
            <CreditCard value={t('pricing.credits.metered', '按量')}
              title={t('pricing.credits.build.title', '生成一次界面')}
              body={t('pricing.credits.build.body', 'Boris 在容器里写完整个前端并跑起来,算上容器时长,所以更贵。')} />
            <CreditCard value="0" unit={t('pricing.credits.unit', 'credits')}
              title={t('pricing.credits.free.title', '用你已经建好的东西')}
              body={t('pricing.credits.free.body', '读写数据、访问应用、连数据库、调数据 API,都不扣额度。')} />
          </div>
        </Container>
      </section>

      {/* ── Comparison ── */}
      <section className="py-16 border-t border-edge">
        <Container>
          <SectionHead eyebrow={t('pricing.compare.eyebrow', '对比')} title={t('pricing.compare.title', '三个套餐分别包含什么')} />
          <div className="mt-8 overflow-x-auto rounded-2xl border border-edge bg-panel">
            <table className="w-full min-w-[36rem] text-left border-collapse">
              <thead>
                <tr className="border-b border-edge">
                  <th className="font-normal text-[12.5px] text-fg-dim px-5 py-3.5 w-[38%]">{t('pricing.compare.head', '功能')}</th>
                  {PLAN_IDS.map((p) => (
                    <th key={p} className="px-5 py-3.5">
                      <span className="text-[13.5px] font-medium text-fg">{PLANS[p].name}</span>
                      {PLANS[p].featured && <span className="ml-2 font-mono text-[10.5px] text-fg-dim">{t('pricing.compare.recommended', '推荐')}</span>}
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
              <SectionHead eyebrow={t('pricing.faq.eyebrow', '常见问题')} title={t('pricing.faq.title', '你大概会问的')} />
              <p className="text-[13px] text-fg-dim mt-5">
                {t('pricing.faq.more.before', '还有别的问题?到')}{' '}
                {hasGithub && (<a href={GITHUB_URL} target="_blank" rel="noreferrer" className="text-fg-mid hover:text-fg underline underline-offset-4 decoration-edge-strong">
                  GitHub
                </a>)}{' '}
                {t('pricing.faq.more.after', '上开个 issue。')}
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

      <section className="border-t border-edge bg-panel">
        <Container className="py-20 text-center">
          <h2 className="font-display text-[26px] sm:text-[32px] font-semibold leading-tight text-balance">
            {t('pricing.cta.title', '免费版就能建出一个真数据库')}
          </h2>
          <p className="text-[14px] text-fg-mid mt-4">
            {t('pricing.cta.sub', '先用这 {n} 额度,把想法建出来再说。').replace('{n}', String(PLANS.free.credits))}
          </p>
          <div className="mt-8 flex justify-center">
            <PrimaryLink to="/signup">{t('cta.startFree', '免费开始')}</PrimaryLink>
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
