import { Fragment, useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { adminClearLlm, adminGrantCredits, adminOverview, adminSaveLlm, adminSetAdmin, adminSetPlan, getProjects, usageDetail } from '../functions'
import { PLANS, PLAN_IDS, planOf, type Plan } from '@lovbase/core/plans'
import { TIERS, TIER_LABEL, type Tier } from '@lovbase/core/billing'
import { Sidebar } from '../components/Sidebar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useDialogs } from '../components/Dialogs'

export const Route = createFileRoute('/admin')({
  loader: async () => {
    const [a, p] = await Promise.all([adminOverview(), getProjects()])
    return { ...a, projects: p.projects, folders: p.folders, limit: p.limit }
  },
  component: Admin,
  head: () => ({ meta: [{ title: '管理后台 · Lovbase' }] }),
})

function Admin() {
  const d = Route.useLoaderData()
  const dialogs = useDialogs()
  const router = useRouter()
  const setPlan = useServerFn(adminSetPlan)
  const setAdmin = useServerFn(adminSetAdmin)
  const saveLlm = useServerFn(adminSaveLlm)
  const clearLlm = useServerFn(adminClearLlm)
  const [baseUrl, setBaseUrl] = useState(d.llm.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [tiers, setTiers] = useState<Record<string, string>>(d.llm.tiers)
  const [defaultTier, setDefaultTier] = useState<Tier>(d.llm.defaultTier)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const grant = useServerFn(adminGrantCredits)
  const detail = useServerFn(usageDetail)
  const [open, setOpen] = useState<string | null>(null)
  const [rows, setRows] = useState<{ day: string; kind: string; credits: number; turns: number }[]>([])

  /**
   * Hand a user credits — an apology, a trial, a customer who paid another way. The amount is
   * typed rather than a fixed button: those three are never the same number, and "+100 four times"
   * is four ledger rows saying nothing about why. A negative amount takes them back.
   */
  async function grantTo(a: { id: string; email: string; bonus: number }) {
    const answer = await dialogs.prompt({
      title: `给 ${a.email} 发额度`,
      description: `钱包现在是 ${a.bonus} 额度。买来和发出的额度不随周期清零,套餐额度用完后才开始扣。填负数可以收回。`,
      label: '额度',
      defaultValue: '100',
      confirmLabel: '发放',
    })
    if (answer === null) return
    const amount = Number(answer.trim())
    if (!Number.isInteger(amount) || amount === 0)
      return void dialogs.alert({ title: '额度要是一个不为零的整数' })
    try {
      await grant({ data: { userId: a.id, amount, note: '管理员发放' } })
      router.invalidate()
    } catch (e) { dialogs.alert({ title: '发放失败', description: e instanceof Error ? e.message : String(e) }) }
  }

  async function inspect(userId: string) {
    if (open === userId) { setOpen(null); return }
    setOpen(userId); setRows([])
    try { const r = await detail({ data: { userId, days: 30 } }); setRows(r.rows) } catch { /* shown as empty */ }
  }

  async function save() {
    setBusy(true); setMsg('')
    try { await saveLlm({ data: { baseUrl, apiKey, tiers, defaultTier } }); setApiKey(''); setMsg('已保存,对所有用户生效'); router.invalidate() }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-ink text-fg antialiased flex">
      <Sidebar user={d.user} credits={(d as any).credits} projects={d.projects} folders={d.folders} used={d.projects.length} limit={d.limit} active="admin" />
      <main className="flex-1 min-w-0 m-2 sm:ml-0 panel-card flex flex-col overflow-hidden">
        <div className="max-w-5xl mx-auto w-full px-4 sm:px-8 pt-16 sm:pt-4 pb-16 space-y-8 overflow-y-auto">
          <div>
            <h1 className="font-display text-[24px] font-semibold">管理后台</h1>
            <p className="text-fg-dim text-[13px] mt-1">用户套餐、管理员、平台模型。只有管理员能看到这里。</p>
          </div>

          <div className="grid grid-cols-3 gap-4 md:grid-cols-6">
            <Stat label="用户" value={d.stats.users} />
            <Stat label="付费用户" value={d.stats.paying} />
            <Stat label="项目总数" value={d.accounts.reduce((n, a) => n + a.projects, 0)} />
            <Stat label="今日额度" value={d.stats.creditsToday} />
            <Stat label="30 天额度" value={d.stats.credits30d} />
            <Stat label="30 天生成界面" value={d.stats.builds30d} />
          </div>

          <section className="rounded-xl border border-edge overflow-hidden">
            <div className="px-5 py-3 border-b border-edge flex items-baseline justify-between">
              <h2 className="text-[14px] font-medium">用户</h2>
              <span className="text-[12px] text-fg-dim">{PLAN_IDS.map((p) => `${PLANS[p].name} ${PLANS[p].credits} 额度 / ${PLANS[p].projects} 项目`).join(' · ')}</span>
            </div>
            {/* A console table has more columns than a phone has millimetres; it scrolls sideways
                inside its own card rather than squeezing every cell into two characters. */}
            <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-[13px]">
              <thead className="text-fg-dim text-left">
                <tr className="border-b border-edge"><th className="px-5 py-2 font-normal">用户</th><th className="px-3 py-2 font-normal">项目</th><th className="px-3 py-2 font-normal">本期额度</th><th className="px-3 py-2 font-normal">注册</th><th className="px-3 py-2 font-normal">套餐</th><th className="px-3 py-2 font-normal">管理员</th></tr>
              </thead>
              <tbody>
                {d.accounts.map((a) => {
                  const cap = planOf(a.plan).credits + a.bonus
                  const pct = cap ? Math.min(100, Math.round((a.used / cap) * 100)) : 0
                  return (
                  <Fragment key={a.id}>
                  <tr key={a.id} className="border-b border-edge/60 last:border-0">
                    <td className="px-5 py-2.5">
                      <button onClick={() => inspect(a.id)} className="text-left cursor-pointer hover:text-fg">
                        <div className="font-medium">{a.name || '—'}</div><div className="text-fg-dim text-[12px]">{a.email}</div>
                      </button>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">{a.projects}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-fg" style={{ width: `${pct}%` }} /></div>
                        <span className="tabular-nums text-[12px] text-fg-mid">{a.used}/{cap}</span>
                        {a.bonus > 0 && <span className="tabular-nums text-[11.5px] text-fg-dim" title="钱包(购买或发放,不随周期清零)">+{a.bonus}</span>}
                        <button onClick={() => grantTo(a)}
                          className="text-[11.5px] text-fg-dim hover:text-fg cursor-pointer">发额度</button>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-fg-mid">{new Date(a.createdAt).toISOString().slice(0, 10)}</td>
                    <td className="px-3 py-2.5">
                      <div className="inline-flex rounded-lg border border-edge p-0.5">
                        {PLAN_IDS.map((p) => (
                          <button key={p} onClick={() => setPlan({ data: { userId: a.id, plan: p as Plan } }).then(() => router.invalidate())}
                            className={`px-2.5 py-1 rounded-md text-[12px] cursor-pointer ${a.plan === p ? 'bg-fg text-ink' : 'text-fg-mid hover:text-fg'}`}>{PLANS[p].name}</button>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <Switch checked={a.isAdmin} disabled={a.id === d.user.id}
                        onCheckedChange={(v: boolean) => setAdmin({ data: { userId: a.id, isAdmin: v } }).then(() => router.invalidate()).catch((e) => dialogs.alert({ title: '出错了', description: e.message }))} />
                    </td>
                  </tr>
                  {open === a.id && (
                    <tr key={a.id + ':usage'} className="border-b border-edge/60 bg-panel-2/40">
                      <td colSpan={6} className="px-5 py-3">
                        <p className="text-[12px] text-fg-dim mb-2">近 30 天消耗</p>
                        {rows.length === 0 ? <p className="text-[12.5px] text-fg-dim">还没有消耗记录</p> : (
                          <div className="flex flex-wrap gap-x-6 gap-y-1">
                            {rows.map((r, i) => (
                              <span key={i} className="text-[12.5px] text-fg-mid tabular-nums">
                                {r.day} · {r.kind === 'build_app' ? '生成界面' : '对话'} {r.turns} 次 · {r.credits} 额度
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )})}
              </tbody>
            </table>
            </div>
          </section>

          <section className="rounded-xl border border-edge overflow-hidden">
            <div className="px-5 py-3 border-b border-edge"><h2 className="text-[14px] font-medium">消耗排行 · 近 30 天</h2></div>
            {d.top.length === 0 ? <p className="px-5 py-4 text-[13px] text-fg-dim">还没有消耗记录</p> : (
              <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem] text-[13px]">
                <thead className="text-fg-dim text-left">
                  <tr className="border-b border-edge"><th className="px-5 py-2 font-normal">用户</th><th className="px-3 py-2 font-normal">套餐</th><th className="px-3 py-2 font-normal">额度</th><th className="px-3 py-2 font-normal">轮次</th><th className="px-3 py-2 font-normal">最近一次</th></tr>
                </thead>
                <tbody>
                  {d.top.map((t) => (
                    <tr key={t.userId} className="border-b border-edge/60 last:border-0">
                      <td className="px-5 py-2.5">{t.name || t.email}</td>
                      <td className="px-3 py-2.5 text-fg-mid">{planOf(t.plan).name}</td>
                      <td className="px-3 py-2.5 tabular-nums font-medium">{t.credits}</td>
                      <td className="px-3 py-2.5 tabular-nums text-fg-mid">{t.turns}</td>
                      <td className="px-3 py-2.5 tabular-nums text-fg-mid">{new Date(t.lastAt).toISOString().slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-edge p-5 space-y-4">
            <div>
              <h2 className="text-[14px] font-medium">平台模型</h2>
              <p className="text-[12.5px] text-fg-dim mt-1">所有用户的生成都走这里配置的模型。任何 OpenAI 兼容端点;key 加密存储。
                当前生效:<span className="text-fg font-mono">{d.llm.effective || '未配置'}</span>{d.llm.fromEnv && <span className="text-fg-dim">(来自环境变量)</span>}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="eyebrow block mb-1.5">Base URL</span><Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="font-mono" /></label>
              <label className="block"><span className="eyebrow block mb-1.5">API key</span><Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={d.llm.hasKey ? '已保存,留空不改' : 'sk-…'} className="font-mono" /></label>
            </div>
            <div className="space-y-2">
              <p className="eyebrow">三档模型 · 用户在对话框里按档位选,你随时可以换掉某一档背后的模型</p>
              {TIERS.map((tier) => (
                <div key={tier} className="flex items-center gap-3">
                  <label className="flex items-center gap-2 w-28 shrink-0 cursor-pointer" title="设为默认档位">
                    <input type="radio" name="defaultTier" checked={defaultTier === tier} onChange={() => setDefaultTier(tier)}
                      disabled={!tiers[tier]} className="accent-accent" />
                    <span className="text-[13px]">{TIER_LABEL[tier].zh}</span>
                  </label>
                  <Input value={tiers[tier] ?? ''} onChange={(e) => setTiers((v) => ({ ...v, [tier]: e.target.value }))}
                    placeholder={tier === 'fast' ? '留空 = 不提供这一档' : tier === 'standard' ? 'gpt-5.2 / claude-sonnet-5' : 'claude-opus-5'}
                    className="font-mono" />
                </div>
              ))}
              <p className="text-[12px] text-fg-dim">留空的档位在对话框里不出现;用户选了已下线的档位会自动落到默认档。</p>
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={save} disabled={busy || !baseUrl || !Object.values(tiers).some((m) => m?.trim())}>保存</Button>
              {(d.llm.baseUrl || d.llm.hasKey) && <Button variant="ghost" onClick={() => clearLlm().then(() => { setBaseUrl(''); setTiers({}); router.invalidate() })}>清除,回退到环境变量</Button>}
              {msg && <span className="text-[12.5px] text-fg-mid">{msg}</span>}
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl border border-edge p-4"><p className="text-[12.5px] text-fg-dim">{label}</p><p className="text-[24px] font-semibold tabular-nums mt-1">{value}</p></div>
}
