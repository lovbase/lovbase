import { useState } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getProjects, newProject, requestUpgrade } from '../functions'
import { Sidebar } from '../components/Sidebar'
import { Logo } from '../components/Logo'
import { Composer, useTier, type ComposerMessage } from '../components/Composer'
import { stashStart } from '../lib/handoff'
import { useT } from '../lib/i18n'
import { track } from '../lib/posthog'

/** The greeting follows the clock, the way a person's would. */
function greeting(hour: number): string {
  if (hour < 5) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

// The signed-in home. `/` is the public landing and redirects here for anyone with a session,
// so neither page has to render the other's shell first.
export const Route = createFileRoute('/home')({
  loader: async () => {
    try { return await getProjects() } catch { throw redirect({ to: '/login' }) }
  },
  component: HomeRoute,
})

function HomeRoute() {
  const { user, projects, folders, limit, credits, tiers } = Route.useLoaderData()
  return AppHomeBody({ user, projects, folders, limit, credits, tiers })
}

function AppHomeBody({ user, projects, folders, limit, credits, tiers }: Awaited<ReturnType<typeof getProjects>>) {
  const router = useRouter()
  const create = useServerFn(newProject)
  const upgrade = useServerFn(requestUpgrade)
  const t = useT()
  const [tier, pickTier] = useTier(tiers)
  const [busy, setBusy] = useState(false)
  const [limitHit, setLimitHit] = useState(false)
  const [upgraded, setUpgraded] = useState(false)

  async function start(msg: ComposerMessage) {
    const p = msg.text.trim()
    if (busy) return
    setBusy(true)
    try {
      const { id, state } = await create()
      track('project_created', { fromPrompt: !!p, hasFiles: msg.files.length > 0 })
      // The page opens on what this call already knows. The sidebar is the one this page has,
      // with the new project at the top: it is not on the server's list until it has a name.
      stashStart({
        projectId: id, prompt: p, files: msg.files, state,
        shell: { user, projects: [{ id, folderId: null, starred: false, name: '', entities: 0, tables: [], shared: false, cover: null, updated_at: new Date().toISOString() }, ...projects], folders, limit, credits, tiers },
      })
      router.navigate({ to: '/projects/$projectId', params: { projectId: id } })
    } catch (e) {
      if (e instanceof Error && e.message.includes('LIMIT:')) setLimitHit(true)
      else throw e
    } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-ink text-fg antialiased flex">
      <Sidebar user={user} credits={credits} projects={projects} folders={folders} used={projects.length} limit={limit} active="home" />

      {/* One column, one question. The page used to open with a badge, a headline, a subline and a
          form; a person arriving to build something has one thing to say, and the page should be
          shaped around saying it. Everything else is quieter and lower. */}
      <main className="flex-1 min-w-0 m-2 sm:ml-0 panel-card overflow-hidden flex flex-col relative lb-rise-slow">
        <section className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 pt-20 pb-28 relative z-10">
          <Logo size={44} />
          <h1 className="font-display text-[40px] sm:text-[52px] font-medium tracking-tight leading-none mt-6 text-fg">
            {greeting(new Date().getHours())}{user.name ? `,${user.name}` : ''}
          </h1>

          <div className="w-full max-w-[42rem] mt-10 text-left">
            <Composer size="lg"
              tiers={tiers} tier={tier} onTier={pickTier} listFiles={async () => []}
              placeholder={t('home.placeholder', '描述你想要的应用…')}
              status={busy ? 'submitted' : 'ready'}
              onSubmit={(msg) => start(msg)}
            />
          </div>

          {limitHit && (
            <div className="w-full max-w-[42rem] mt-4 flex items-center gap-4 text-left border border-accent/30 bg-accent/5 rounded-2xl px-4 py-3">
              <p className="text-[13px] text-fg-mid flex-1">免费版最多 {limit} 个项目。付费版不限项目数,并可直连数据库。</p>
              <button onClick={() => upgrade({ data: { source: 'home' } }).then(() => setUpgraded(true))} disabled={upgraded}
                className="px-3.5 py-1.5 bg-accent text-on-accent rounded-lg text-[12.5px] font-medium cursor-pointer hover:bg-accent-soft disabled:opacity-60 shrink-0">
                {upgraded ? '已登记,我们会联系你' : '我要升级'}
              </button>
            </div>
          )}

        </section>
        <div className="dot-field absolute inset-x-0 bottom-0 h-64 pointer-events-none" aria-hidden />
      </main>
    </div>
  )
}
