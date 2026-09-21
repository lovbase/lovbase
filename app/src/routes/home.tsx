import { useState } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getProjects, newProject, requestUpgrade } from '../functions'
import { Sidebar } from '../components/Sidebar'
import { track } from '../lib/posthog'

// The signed-in home. `/` is the public landing and redirects here for anyone with a session,
// so neither page has to render the other's shell first.
export const Route = createFileRoute('/home')({
  loader: async () => {
    try { return await getProjects() } catch { throw redirect({ to: '/login' }) }
  },
  component: HomeRoute,
})

function HomeRoute() {
  const { user, projects, folders, limit, credits } = Route.useLoaderData()
  return AppHomeBody({ user, projects, folders, limit, credits })
}

function AppHomeBody({ user, projects, folders, limit, credits }: Awaited<ReturnType<typeof getProjects>>) {
  const router = useRouter()
  const create = useServerFn(newProject)
  const upgrade = useServerFn(requestUpgrade)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [limitHit, setLimitHit] = useState(false)
  const [upgraded, setUpgraded] = useState(false)

  async function start(text?: string) {
    const p = (text ?? prompt).trim()
    if (busy) return
    setBusy(true)
    try {
      const { id } = await create()
      track('project_created', { fromPrompt: !!p })
      router.navigate({ to: '/projects/$projectId', params: { projectId: id }, search: p ? { prompt: p } : {} })
    } catch (e) {
      if (e instanceof Error && e.message.includes('LIMIT:')) setLimitHit(true)
      else throw e
    } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-ink text-fg antialiased flex">
      <Sidebar user={user} credits={credits} projects={projects} folders={folders} used={projects.length} limit={limit} active="home" />

      <main className="flex-1 min-w-0 m-2 sm:ml-0 panel-card overflow-hidden flex flex-col">
        <div className="hero-wash relative">
          <section className="max-w-2xl mx-auto px-4 sm:px-6 pt-16 pb-20 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-panel border border-edge text-[12px] text-fg-mid mb-5">
            <span className="size-1.5 rounded-full bg-ok" /> 一句话,一个能用的应用 · 底下是真 Postgres
          </div>
          <h1 className="font-display text-[28px] sm:text-[36px] font-semibold text-balance leading-tight">
            想做什么,{user.name || '朋友'}?
          </h1>
          <p className="text-fg-dim text-[14px] mt-2">一句话描述,得到一个真实的数据库和可用的应用。</p>

          <div className="mt-7 text-left bg-panel border border-edge rounded-2xl p-2 shadow-2xl shadow-black/10 dark:shadow-black/40
                          focus-within:border-edge-strong transition-colors">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start() } }}
              rows={3}
              placeholder="比如:做一个客户管理系统,记录客户、联系人和跟进记录…"
              className="w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[15px] text-fg placeholder-fg-dim focus:outline-none"
            />
            <div className="flex items-center justify-between px-2 pb-1">
              <span className="text-[11px] text-fg-dim">Enter 开始 · Shift+Enter 换行</span>
              <button onClick={() => start()} disabled={busy || !prompt.trim()}
                className="px-4 py-2 bg-accent text-on-accent rounded-lg text-[13px] font-medium
                           hover:bg-accent-soft disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer">
                开始构建
              </button>
            </div>
          </div>

          {limitHit && (
            <div className="mt-6 flex items-center gap-4 text-left border border-accent/30 bg-accent/5 rounded-xl px-4 py-3">
              <p className="text-[13px] text-fg-mid flex-1">
                免费版最多 {limit} 个项目。付费版不限项目数,并可直连数据库。
              </p>
              <button onClick={() => upgrade({ data: { source: 'home' } }).then(() => setUpgraded(true))} disabled={upgraded}
                className="px-3.5 py-1.5 bg-accent text-on-accent rounded-lg text-[12.5px] font-medium cursor-pointer
                           hover:bg-accent-soft disabled:opacity-60 shrink-0">
                {upgraded ? '已登记,我们会联系你' : '我要升级'}
              </button>
            </div>
          )}
        </section>
        </div>

      </main>

    </div>
  )
}
