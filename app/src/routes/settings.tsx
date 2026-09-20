import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { AvatarPicker } from '../components/AvatarPicker'
import { billingPortal, clearSettings, getProjects, getSettings, myCredits, saveSettings, startCheckout } from '../functions'
import { PLANS, planOf } from '@lovbase/core/plans'
import { useT } from '../lib/i18n'
import { Link } from '@tanstack/react-router'
import { Sidebar } from '../components/Sidebar'
import { ThemeChoice } from '../components/ThemeChoice'
import { LocaleToggle } from '../components/LocaleToggle'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRouter } from '@tanstack/react-router'

export const Route = createFileRoute('/settings')({
  loader: async () => ({ ...(await getProjects()), ...(await myCredits()), llm: await getSettings() }),
  component: Account,
  head: () => ({ meta: [{ title: '账户 · Lovbase' }] }),
})

function Account() {
  const t = useT()
  const d = Route.useLoaderData()
  const checkout = useServerFn(startCheckout)
  const portal = useServerFn(billingPortal)
  const [asked, setAsked] = useState(false)
  const [busy, setBusy] = useState(false)
  const spec = planOf(d.user.plan)
  const paid = d.user.plan !== 'free'
  const b = d.balance
  const cap = b.included + b.bonus
  const pct = cap ? Math.min(100, Math.round((b.used / cap) * 100)) : 0
  const byKind = d.rows.reduce<Record<string, { credits: number; turns: number }>>((acc, r) => {
    const k = acc[r.kind] ?? { credits: 0, turns: 0 }
    acc[r.kind] = { credits: k.credits + r.credits, turns: k.turns + r.turns }
    return acc
  }, {})

  async function upgradeTo(plan: 'pro' | 'business') {
    setBusy(true)
    try {
      const r = await checkout({ data: { plan, origin: location.origin } })
      if (r.url) location.href = r.url
      else setAsked(true)
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return (
    <div className="min-h-screen bg-ink text-fg antialiased flex">
      <Sidebar user={d.user} credits={(d as any).credits} projects={d.projects} folders={d.folders} used={d.projects.length} limit={d.limit} active="settings" />
      <main className="flex-1 min-w-0 m-2 ml-0 rounded-2xl border border-edge bg-panel shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_-12px_rgba(0,0,0,.12)] flex flex-col">
        <div className="max-w-3xl mx-auto w-full px-6 pt-6 pb-16 space-y-8">
          <div>
            <h1 className="font-display text-[24px] font-semibold">{t('account.title', '账户')}</h1>
            <p className="text-fg-dim text-[13px] mt-1">{t('account.subtitle', '套餐、用量与模型。默认走平台统一配置的模型,Pro 起可以换成自己的。')}</p>
          </div>
          <section className="rounded-xl border border-edge p-5 space-y-4">
            <AvatarPicker user={d.user} />
            <Row label={t('account.email', '邮箱')} value={d.user.email} />
            <Row label={t('account.name', '名字')} value={d.user.name || '—'} />
            <Row label={t('account.plan', '套餐')} value={spec.name} />
            <Row label={t('account.model', '当前模型')} value={d.llm.effective || '未配置'} />
            <Row label={t('account.projectQuota', '项目额度')} value={`${d.projects.length} / ${d.limit}`} />
          </section>

          {/* Appearance lives here rather than in a corner of every page: it is set once, and a
              control repeated on four screens is four places to look for it. */}
          <section className="rounded-xl border border-edge p-5 space-y-4">
            <h2 className="text-[13.5px] font-medium">{t('settings.appearance', '外观')}</h2>
            <div className="flex items-center justify-between gap-4">
              <span className="text-[13.5px] text-fg-dim">{t('settings.theme', '主题')}</span>
              <ThemeChoice />
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-[13.5px] text-fg-dim">{t('settings.language', '语言')}</span>
              <LocaleToggle />
            </div>
          </section>

          <section className="rounded-xl border border-edge p-5 space-y-3">
            <div className="flex items-baseline justify-between">
              <p className="text-[14px] font-medium">{t('account.credits', '本期额度')}</p>
              <p className="text-[12.5px] text-fg-dim tabular-nums">重置于 {new Date(b.periodEnd).toISOString().slice(0, 10)}</p>
            </div>
            <div className="h-2 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-fg transition-[width]" style={{ width: `${pct}%` }} /></div>
            <p className="text-[13px] text-fg-mid tabular-nums">
              已用 {b.used} · 剩余 <span className="text-fg font-medium">{b.left}</span> · 本期共 {cap}
              {b.bonus > 0 && <span className="text-fg-dim">(含赠送 {b.bonus})</span>}
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1 border-t border-edge/60">
              {Object.entries(byKind).length === 0
                ? <span className="text-[12.5px] text-fg-dim">近 30 天还没有消耗</span>
                : Object.entries(byKind).map(([k, v]) => (
                    <span key={k} className="text-[12.5px] text-fg-mid tabular-nums">
                      {k === 'build_app' ? '生成界面' : '对话'} {v.turns} 次 · {v.credits} 额度
                    </span>
                  ))}
            </div>
            <p className="text-[12px] text-fg-dim">额度按每轮实际用掉的 token 和模型档位扣;自带模型(BYOK)的对话不扣。</p>
          </section>
          <ModelSection llm={d.llm} />

          {paid ? (
            <section className="rounded-xl border border-edge p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-[14px] font-medium">{t('account.subscription', '订阅')}</p>
                <p className="text-[12.5px] text-fg-dim mt-0.5">{spec.name} · ${spec.price}/月 · 每月 {spec.credits} 额度</p>
              </div>
              {d.billing
                ? <Button variant="ghost" onClick={() => portal({ data: { origin: location.origin } }).then((r) => { location.href = r.url }).catch((e) => alert(e.message))}>{t('account.manage', '管理订阅')}</Button>
                : <Link to="/pricing" className="text-[13px] text-fg-mid hover:text-fg underline underline-offset-4">查看价格</Link>}
            </section>
          ) : (
            <section className="rounded-xl border border-edge p-5 space-y-4">
              <div>
                <p className="text-[14px] font-medium">升级</p>
                <p className="text-[12.5px] text-fg-dim mt-0.5">额度不够用,或者想要更多项目、数据库直连和自定义域名。</p>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                {(['pro', 'business'] as const).map((p) => (
                  <div key={p} className="rounded-lg border border-edge p-4">
                    <p className="text-[13px] font-medium">{PLANS[p].name}</p>
                    <p className="text-[20px] font-semibold tabular-nums mt-0.5">${PLANS[p].price}<span className="text-[12px] text-fg-dim font-normal">/月</span></p>
                    <p className="text-[12px] text-fg-dim mt-1">{PLANS[p].credits} 额度 · {PLANS[p].projects} 项目</p>
                    <Button className="w-full mt-3" onClick={() => upgradeTo(p)} disabled={busy || asked}>
                      {asked ? '已登记,会联系你' : `升级到 ${PLANS[p].name}`}
                    </Button>
                  </div>
                ))}
              </div>
              <Link to="/pricing" className="inline-block text-[12.5px] text-fg-mid hover:text-fg underline underline-offset-4">对比全部套餐</Link>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between text-[13.5px]"><span className="text-fg-dim">{label}</span><span className="tabular-nums">{value}</span></div>
}

/**
 * Bring your own model. Paid plans only: on Free this shows what the feature is and points at
 * pricing rather than pretending the fields are editable.
 */
function ModelSection({ llm }: { llm: Awaited<ReturnType<typeof getSettings>> }) {
  const t = useT()
  const save = useServerFn(saveSettings)
  const clear = useServerFn(clearSettings)
  const router = useRouter()
  const [baseUrl, setBaseUrl] = useState(llm.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(llm.model)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  if (!llm.canByok)
    return (
      <section className="rounded-xl border border-edge p-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-[14px] font-medium">{t('account.byok.title', '自带模型与 key')}</p>
          <p className="text-[12.5px] text-fg-dim mt-1 max-w-md leading-relaxed">
            {t('account.byok.locked', '接自己的 OpenAI 兼容端点,用自己的模型和额度,key 以 AES-GCM 加密存储。Pro 及以上可用。现在用的是平台统一配置的模型。')}
          </p>
        </div>
        <Link to="/pricing" className="shrink-0 inline-flex items-center h-8 px-3.5 rounded-lg bg-fg text-ink text-[12.5px] font-medium">{t('account.byok.unlock', '升级解锁')}</Link>
      </section>
    )

  async function submit() {
    setBusy(true); setMsg('')
    try {
      await save({ data: { baseUrl, apiKey, model } })
      setApiKey(''); setMsg('已保存,之后的生成走你自己的模型'); router.invalidate()
    } catch (e) { setMsg(e instanceof Error ? e.message.replace(/^LIMIT:/, '') : String(e)) } finally { setBusy(false) }
  }

  return (
    <section className="rounded-xl border border-edge p-5 space-y-4">
      <div>
        <p className="text-[14px] font-medium">{t('account.byok.title', '自带模型与 key')}</p>
        <p className="text-[12.5px] text-fg-dim mt-1">任何 OpenAI 兼容端点。key 加密存储,只用于你自己的生成。留空则回退到平台模型。</p>
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <label className="block"><span className="eyebrow block mb-1.5">Base URL</span>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="font-mono" /></label>
        <label className="block"><span className="eyebrow block mb-1.5">API key</span>
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={llm.keyUnreadable ? '请重新输入' : llm.hasKey ? '已保存,留空不改' : 'sk-…'} className="font-mono" /></label>
        <label className="block"><span className="eyebrow block mb-1.5">模型</span>
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-5.2 / claude-sonnet-5" className="font-mono" /></label>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={submit} disabled={busy || !baseUrl || !model}>保存</Button>
        {llm.keyUnreadable && (
          <p className="text-[12.5px] text-amber-600 dark:text-amber-500">
            保存的 key 已经无法解密(加密密钥变过),现在走的是平台模型。重新填一次 key 就能恢复。
          </p>
        )}
        {(llm.baseUrl || llm.hasKey) && (
          <Button variant="ghost" onClick={() => clear().then(() => { setBaseUrl(''); setModel(''); setApiKey(''); router.invalidate() })}>
            清除,回到平台模型
          </Button>
        )}
        {msg && <span className="text-[12.5px] text-fg-mid">{msg}</span>}
      </div>
      <p className="text-[12px] text-fg-dim">额度照常计算:一次对话仍是 1 额度,因为沙箱和数据库还是我们在跑。</p>
    </section>
  )
}
