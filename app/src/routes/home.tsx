import { UpgradeButton } from '../components/UpgradeButton'
import { CheckoutNotice } from '../components/CheckoutNotice'
import { useEffect, useState } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getProjects, newProject } from '../functions'
import { TemplatesGallery } from '../components/TemplatesGallery'
import { LANDING_DRAFT } from '../components/marketing/HeroPrompt'
import { Sidebar } from '../components/Sidebar'
import { Logo } from '../components/Logo'
import { Composer, useTier, type ComposerMessage } from '../components/Composer'
import { stashStart } from '../lib/handoff'
import { useT } from '../lib/i18n'
import { track } from '../lib/posthog'
import { seoNoIndex } from '../lib/seo'

type T = ReturnType<typeof useT>

/** The greeting follows the clock, the way a person's would. */
function greeting(hour: number, t: T): string {
  if (hour < 5) return t('home.greeting.night', 'Up late')
  if (hour < 12) return t('home.greeting.morning', 'Good morning')
  if (hour < 14) return t('home.greeting.noon', 'Good afternoon')
  if (hour < 18) return t('home.greeting.afternoon', 'Good afternoon')
  return t('home.greeting.evening', 'Good evening')
}

// The signed-in home. `/` is the public landing and redirects here for anyone with a session,
// so neither page has to render the other's shell first.
export const Route = createFileRoute('/home')({
  validateSearch: (s: Record<string, unknown>): {checkout?:string;canceled?:boolean} => ({checkout: typeof s.checkout === 'string' ? s.checkout : undefined, canceled: (s.canceled === '1' || s.canceled === 1 || s.canceled === true) ? true : undefined}),
  loader: async () => {
    try { return await getProjects() } catch { throw redirect({ to: '/login' }) }
  },
  head: () => seoNoIndex('Home · Lovbase'),
  component: HomeRoute,
})

function HomeRoute() {
  const { user, projects, folders, limit, credits, tiers } = Route.useLoaderData()
  return AppHomeBody({ user, projects, folders, limit, credits, tiers })
}

function AppHomeBody({ user, projects, folders, limit, credits, tiers }: Awaited<ReturnType<typeof getProjects>>) {
  const router = useRouter()
  const create = useServerFn(newProject)
  const t = useT()
  const [tier, pickTier] = useTier(tiers)
  const [busy, setBusy] = useState(false)
  const [limitHit, setLimitHit] = useState(false)
  // What someone typed on the landing page before signing up. Read after mount: sessionStorage
  // does not exist on the server, and the box remounts with it via its key.
  const [draft, setDraft] = useState('')
  useEffect(() => {
    try {
      const d = sessionStorage.getItem(LANDING_DRAFT)
      if (d) { setDraft(d); sessionStorage.removeItem(LANDING_DRAFT) }
    } catch {}
  }, [])

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
        <section className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 pt-16 pb-16 relative z-10">
          <Logo size={44} />
          <h1 className="font-display text-[40px] sm:text-[52px] font-medium tracking-tight leading-none mt-6 text-fg">
            {greeting(new Date().getHours(), t)}{user.name ? `, ${user.name}` : ''}
          </h1>

          <div className="w-full max-w-[42rem] mt-10 text-left">
            <Composer size="lg" key={draft} initialText={draft}
              tiers={tiers} tier={tier} onTier={pickTier} listFiles={async () => []}
              placeholder={t('home.placeholder', 'Describe the app you want…')}
              status={busy ? 'submitted' : 'ready'}
              onSubmit={(msg) => start(msg)}
            />
          </div>

          {limitHit && (
            <div className="w-full max-w-[42rem] mt-4 flex items-center gap-4 text-left border border-accent/30 bg-accent/5 rounded-2xl px-4 py-3">
              <p className="text-[13px] text-fg-mid flex-1">{t('home.limit.hint', 'Your plan allows {limit} projects. Pro includes 25 projects and read-only database access.').replace('{limit}', String(limit))}</p>
              <UpgradeButton plan={user.plan} source="home" className="px-3.5 py-1.5 bg-accent text-on-accent rounded-lg text-[12.5px] font-medium cursor-pointer shrink-0" />
            </div>
          )}

        </section>
        <CheckoutNotice sessionId={Route.useSearch().checkout} canceled={Route.useSearch().canceled} />
        <TemplatesGallery signedIn compact />
        <div className="dot-field absolute inset-x-0 bottom-0 h-64 pointer-events-none" aria-hidden />
      </main>
    </div>
  )
}
