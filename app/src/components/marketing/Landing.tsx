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
    title: t('landing.steps.describe.title', '你描述要做什么'),
    body: t('landing.steps.describe.body', '用中文说清楚业务:客户、订单、跟进记录。不用先想字段,也不用先画表。'),
  },
  {
    icon: Database,
    title: t('landing.steps.schema.title', '它设计一个真 schema'),
    body: t('landing.steps.schema.body', '模型产出带稳定 ID 的 IR,确定性代码把它编译成 DDL,在你的 Postgres 里建出真表。'),
  },
  {
    icon: Bot,
    title: t('landing.steps.build.title', 'Boris 写出界面'),
    body: t('landing.steps.build.body', '编码 agent Boris 在沙箱容器里写 React 前端,直接读写你刚建好的表,写完就能点。'),
  },
  {
    icon: Globe,
    title: t('landing.steps.ship.title', '发布,继续改'),
    body: t('landing.steps.ship.body', '一键发布分享链接。之后再改需求,改名是 RENAME,不是删表重建,已有数据一行不丢。'),
  },
]

const features = (t: T) => [
  {
    icon: Database,
    title: t('landing.features.db.title', '一个真的 Postgres 数据库'),
    body: t('landing.features.db.body', '不是内置的玩具存储,也不是导出的 CSV。每个项目一个独立 schema,给你连接串,psql、DBeaver、Metabase、Prisma 想连就连。'),
    points: [
      t('landing.features.db.p1', '独立 schema + 受限角色'),
      t('landing.features.db.p2', '随时导出 SQL'),
      t('landing.features.db.p3', 'REST 数据 API'),
    ],
  },
  {
    icon: ShieldCheck,
    title: t('landing.features.safe.title', 'AI 删不掉你的数据'),
    body: t('landing.features.safe.body', 'LLM 从不直接写 SQL。它只产出 IR,由确定性 diff 算出变更,再编译成白名单内的 DDL。删表、删列、改类型必须由你在界面上确认。'),
    points: [
      t('landing.features.safe.p1', 'IR → diff → 白名单 DDL'),
      t('landing.features.safe.p2', '改名识别为 RENAME'),
      t('landing.features.safe.p3', '破坏性变更需人工确认'),
    ],
  },
  {
    icon: Server,
    title: t('landing.features.selfhost.title', '完全可自托管'),
    body: t('landing.features.selfhost.body', '数据库、主应用、跑代码的沙箱都能落在你自己的机器上。docker compose 起 Postgres,沙箱 runner 一个 app 一个容器,跑在任意 Docker 主机。'),
    points: [
      t('landing.features.selfhost.p1', 'docker compose 起本地环境'),
      t('landing.features.selfhost.p2', '沙箱 runner 可私有部署'),
      t('landing.features.selfhost.p3', '预览走你自己的域名'),
    ],
  },
  {
    icon: KeyRound,
    title: t('landing.features.byok.title', 'BYOK,自带模型'),
    body: t('landing.features.byok.body', 'Pro 起可以填自己的 OpenAI 兼容端点和 key,AES-GCM 加密存储。用你自己的模型和账单,也可以指向内网自部署的模型。'),
    points: [
      t('landing.features.byok.p1', 'OpenAI 兼容端点'),
      t('landing.features.byok.p2', 'key 加密存储'),
      t('landing.features.byok.p3', 'Pro 起可用'),
    ],
  },
]

const openFacts = (t: T) => [
  { k: t('landing.open.code.k', '整套代码可读'), v: t('landing.open.code.v', '引擎、SQL 网关、沙箱 runner 都在仓库里,不是只开一个 SDK。') },
  { k: t('landing.open.local.k', '本地能跑起来'), v: t('landing.open.local.v', 'docker compose 起 Postgres,bun run dev 就是完整的产品。') },
  { k: t('landing.open.data.k', '数据在你的库里'), v: t('landing.open.data.v', '自托管时连接串是你自己的,我们连不上。') },
  { k: t('landing.open.model.k', '模型可以换'), v: t('landing.open.model.v', '自托管时模型端点由你自己配置;托管版 Pro 起支持 BYOK。') },
]

const selfHostLines = (t: T) => [
  'git clone <repo> && cd lovbase',
  'docker compose up -d          # Postgres',
  t('landing.selfhost.line.env', 'cp .env.example app/.dev.vars # LLM key,或走 BYOK'),
  'bun install && bun run dev    # localhost:3000',
]

export function Landing() {
  const [billing, setBilling] = useState<Billing>('monthly')
  const t = useT()
  const STEPS = steps(t)
  const FEATURES = features(t)
  const OPEN_FACTS = openFacts(t)
  const SELF_HOST_LINES = selfHostLines(t)

  return (
    <div className="min-h-screen bg-ink text-fg antialiased">
      <MarketingHeader />

      {/* ── Hero ── */}
      <section className="hero-wash border-b border-edge">
        <Container className="pt-16 sm:pt-24 pb-14 sm:pb-20">
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-panel border border-edge text-[12px] text-fg-mid">
              <span className="size-1.5 rounded-full bg-ok" />
              {t('landing.hero.badge', '开源的 Lovable 替代品 · 建在你自己的 Postgres 上')}
            </div>
            <h1 className="font-display text-[38px] sm:text-[56px] font-semibold leading-[1.08] tracking-tight text-balance mt-6">
              {t('landing.hero.title.a', '一句话,得到一个真的数据库')}
              <br className="hidden sm:block" />
              {t('landing.hero.title.b', '和一个能用的应用')}
            </h1>
            <p className="text-[15px] sm:text-[16.5px] leading-relaxed text-fg-mid mt-5 max-w-xl mx-auto text-balance">
              {t('landing.hero.sub', '你描述业务,AI 设计出真实的 Postgres schema,编码 agent Boris 写出前端。数据库归你——任何客户端都能直接连,改需求也不会丢掉已有数据。')}
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-8">
              <PrimaryLink to="/signup" className="w-full sm:w-auto">
                {t('nav.start', '开始构建')} <ArrowRight className="size-4" />
              </PrimaryLink>
              <GhostLink to="/pricing" className="w-full sm:w-auto">{t('landing.hero.seePricing', '查看价格')}</GhostLink>
            </div>
            <p className="text-[12.5px] text-fg-dim mt-4">
              {t('landing.hero.note', '免费开始 · 每月 {credits} 次对话额度 · 无需信用卡').replace('{credits}', String(PLANS.free.credits))}
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
            eyebrow={t('landing.how.eyebrow', '工作方式')}
            title={t('landing.how.title', '从一句话到一个上线的应用,四步')}
            sub={t('landing.how.sub', '中间没有“导出再自己接数据库”这一步。数据库从第一步就是真的。')}
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
            eyebrow={t('landing.features.eyebrow', '为什么不一样')}
            title={t('landing.features.title', '别的工具给你一个 demo,Lovbase 给你一套基础设施')}
            sub={t('landing.features.sub', '生成界面这件事大家都会做。区别在于生成完之后,东西是不是还归你。')}
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
      <section id="selfhost" className="scroll-mt-20 py-20 sm:py-24 border-t border-edge bg-panel">
        <Container>
          <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-start">
            <div>
              <SectionHead
                eyebrow={t('landing.open.eyebrow', '开源自托管')}
                title={t('landing.open.title', '没有 logo 墙,只有可以自己验证的事实')}
                sub={t('landing.open.sub', '我们不打算摆一排看不出真假的头像和数字。判断一个数据工具是否可信,更直接的办法是把它拉下来自己跑一遍。')}
              />
              <div className="mt-7 rounded-xl border border-edge bg-ink overflow-hidden">
                <div className="px-4 py-2 border-b border-edge flex items-center justify-between">
                  <span className="font-mono text-[11px] text-fg-dim">{t('landing.open.runLocally', '本地跑起来')}</span>
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
              eyebrow={t('nav.pricing', '价格')}
              title={t('landing.pricing.title', '按用量计费,不按座位')}
              sub={t('landing.pricing.sub', '额度按每轮实际用掉的 token 扣,自带模型不扣。免费版每月 {free} 额度,够把一个想法建出来。')
                .replace('{free}', String(PLANS.free.credits))}
            />
            <BillingToggle value={billing} onChange={setBilling} />
          </div>
          <div className="mt-10">
            <PlanCards billing={billing} compact />
          </div>
          <div className="mt-8">
            <Link to="/pricing" className="inline-flex items-center gap-1.5 text-[13.5px] text-fg-mid hover:text-fg transition-colors">
              {t('landing.pricing.more', '查看完整功能对比与常见问题')} <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </Container>
      </section>

      {/* ── Final CTA ── */}
      <section className="border-t border-edge bg-panel">
        <Container className="py-20 text-center">
          <h2 className="font-display text-[28px] sm:text-[36px] font-semibold leading-tight text-balance">
            {t('landing.cta.title', '先建一张表,再决定要不要相信它')}
          </h2>
          <p className="text-[14.5px] text-fg-mid mt-4 max-w-lg mx-auto">
            {t('landing.cta.sub', '注册就能建项目,建完立刻拿到连接串。不满意,数据导出带走。')}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-8">
            <PrimaryLink to="/signup" className="w-full sm:w-auto">
              {t('cta.startFree', '免费开始')} <ArrowRight className="size-4" />
            </PrimaryLink>
            <GhostLink to="/pricing" className="w-full sm:w-auto">{t('landing.cta.pricing', '看看价格')}</GhostLink>
          </div>
        </Container>
      </section>

      <MarketingFooter />
    </div>
  )
}
