import { useEffect, useState } from 'react'
import { PanelRightClose, PanelRightOpen, Zap } from 'lucide-react'
import { Link, createFileRoute, notFound, useNavigate, useRouter} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { getProjectState, getProjects, requestUpgrade } from '../functions'
import { getLayout } from '../functions/layout'
import { Sidebar } from '../components/Sidebar'
import { ShareChip } from '../components/ShareChip'
import { AgentsTab } from '../components/AgentsTab'
import type { Focus } from '../components/Workspace'
import { Workspace } from '../components/Workspace'
import { ResizeHandle, useResizable } from '../lib/use-resizable'
import { CHAT_WIDTH, writeLayout } from '../lib/layout-prefs'
import { useT } from '../lib/i18n'
import { PublishChip } from '../components/PublishChip'
import { planOf } from '@lovbase/core/plans'

export const Route = createFileRoute('/projects/$projectId')({
  validateSearch: (s: Record<string, unknown>): { prompt?: string; app?: string } => ({
    ...(typeof s.prompt === 'string' && s.prompt ? { prompt: s.prompt } : {}),
    ...(typeof s.app === 'string' && s.app ? { app: s.app } : {}),
  }),
  loader: async ({ params }) => {
    try {
      const [state, shell, layout] = await Promise.all([
        getProjectState({ data: { projectId: params.projectId } }),
        getProjects(),
        // Panel geometry, so the first paint is already the right shape — see lib/layout-prefs.ts.
        getLayout(),
      ])
      return { state, shell, layout }
    } catch (err) {
      if (err instanceof Error && err.message.includes('项目不存在')) throw notFound()
      throw err
    }
  },
  component: Builder,
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.state.ir.appName || '未命名'} · Lovbase` }] }),
  notFoundComponent: () => <ProjectGone />,
  // Anything that is genuinely unexpected still gets a page rather than a blank screen.
  errorComponent: ({ error }) => <ProjectGone message={error instanceof Error ? error.message : undefined} />,
})

function Builder() {
  const { state, shell, layout } = Route.useLoaderData()
  const { prompt, app: appParam } = Route.useSearch()
  const navigate = useNavigate()
  const projectId = state.project.id
  const appId = state.apps.find((a) => a.id === appParam)?.id ?? state.apps[0]?.id ?? projectId
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const previewUrl = previews[appId] ?? ''
  const setPreviewUrl = (u: string) => setPreviews((m) => ({ ...m, [appId]: u }))
  const [previewNonce, setPreviewNonce] = useState(0)
  const upgrade = useServerFn(requestUpgrade)
  const [flash, setFlash] = useState('')
  const t = useT()
  const routerRef = useRouter()
  const currentApp = state.apps.find((a) => a.id === appId)
  // Chat column collapse, remembered per browser in the layout cookie. ⌘/ toggles it.
  const [chatOpen, setChatOpen] = useState(layout.chat)
  const [focus, setFocus] = useState<Focus | null>(null)
  const [building, setBuilding] = useState(false)
  const chat = useResizable(layout.chatWidth, CHAT_WIDTH.min, CHAT_WIDTH.max, 'right', (w) => writeLayout({ chatWidth: w }))
  const toggleChat = () => setChatOpen((o) => { writeLayout({ chat: !o }); return !o })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); toggleChat() } }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [])


  return (
    <div className="h-screen flex bg-ink text-fg antialiased">
      <Sidebar user={shell.user} credits={shell.credits} projects={shell.projects} folders={shell.folders}
        used={shell.projects.length} limit={shell.limit} active="projects" onProject />

      {/* Two panels rather than one flush pane split by a rule: the chat is its own column, lifted
          off the page the same way the home canvas is, so the eye reads them as siblings. */}
      <div className="flex-1 min-w-0 min-h-0 flex gap-2 p-2 pl-0">
      <div className="flex-1 min-w-0 min-h-0 flex flex-col panel-card overflow-hidden">
      <header className="h-12 shrink-0 flex items-center px-3 gap-3 border-b border-edge bg-panel/40">
        <span className="text-[14px] font-medium truncate max-w-[16rem]">
          {state.ir.entities.length > 0 ? state.ir.appName : t('builder.untitled', '未命名项目')}
        </span>
        <span className="font-mono text-[11px] text-fg-dim px-1.5 py-0.5 rounded-md border border-edge bg-panel">main</span>
        <div className="ml-auto" />
        {!state.hasKey && (
          <span className="font-mono text-[11px] text-warn hidden lg:inline">
            {t('builder.noModel', '未配置模型 → 设置')}
          </span>
        )}
        {flash && <span className="text-[12px] text-fg-mid max-w-[20rem] truncate">{flash}</span>}
        <ShareChip projectId={projectId} token={state.project.shareToken} disabled={state.ir.entities.length === 0} />
        <button onClick={() => upgrade().then(() => setFlash(t('builder.upgradeLogged', '已登记升级意向,我们会联系你')))}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] rounded-lg bg-accent text-on-accent font-medium hover:bg-accent-soft transition-colors cursor-pointer">
          <Zap className="size-3.5" /> {t('nav.upgrade', '升级')}
        </button>
        <PublishChip projectId={projectId} appId={appId}
          url={currentApp?.url ?? null} publishedAt={currentApp?.publishedAt ?? null}
          canCustomise={planOf(state.user?.plan).customSubdomain}
          disabled={!previewUrl}
          onChanged={() => routerRef.invalidate()} />
        {/* Closing happens on the chat panel itself; this is only the way back once it is gone. */}
        {!chatOpen && (
          <button onClick={toggleChat} title={t('builder.expandChat', '展开对话 (⌘/)')}
            className="size-8 shrink-0 grid place-items-center rounded-lg border border-edge text-fg-dim hover:text-fg hover:border-edge-strong transition-colors cursor-pointer">
            <PanelRightOpen className="size-4" />
          </button>
        )}
      </header>

      <main className="flex-1 min-h-0">
        <Workspace state={state} appId={appId} previewUrl={previewUrl} onPreviewUrl={setPreviewUrl} refreshKey={previewNonce} focus={focus} building={building}
          onSelectApp={(id) => navigate({ to: '/projects/$projectId', params: { projectId }, search: { app: id }, replace: true })} />
      </main>
      </div>

      {chatOpen && <ResizeHandle {...chat.handleProps} />}
      <aside className={`shrink-0 min-h-0 flex flex-col overflow-hidden ${chatOpen ? 'panel-card panel-card-quiet' : ''} ${chat.dragging ? '' : 'transition-[width] duration-200'}`}
        style={{ width: chatOpen ? chat.width : 0 }}>
        <div className="h-full flex flex-col min-h-0" style={{ width: chat.width }}>
        {/* The panel's own bar: it carries the control for this column, and gives the transcript a
            solid edge to scroll under instead of disappearing beneath a rounded border. */}
        <div className="h-12 shrink-0 flex items-center justify-between pl-3.5 pr-2 border-b border-edge bg-panel/40">
          <span className="text-[13px] font-medium">{t('builder.chat', '对话')}</span>
          <button onClick={toggleChat} title={t('builder.collapseChat', '收起对话 (⌘/)')}
            className="size-8 grid place-items-center rounded-lg text-fg-dim hover:text-fg hover:bg-panel transition-colors cursor-pointer">
            <PanelRightClose className="size-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0">
        <AgentsTab state={state} appId={appId} initialPrompt={prompt}
          onInitialSent={() => navigate({ to: '/projects/$projectId', params: { projectId }, search: appParam ? { app: appParam } : {}, replace: true })}
          onPreview={setPreviewUrl} onAppChanged={() => setPreviewNonce((n) => n + 1)}
          onFocus={(pane, file) => setFocus({ pane, file, n: Date.now() })}
          onBuilding={setBuilding} />
        </div>
        </div>
      </aside>
      </div>
    </div>
  )
}

/** Shown when a project id leads nowhere: deleted, or belonging to another account. */
function ProjectGone({ message }: { message?: string }) {
  return (
    <div className="min-h-screen bg-ink text-fg flex flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-[15px] font-medium">{message ?? '项目不存在'}</p>
      <p className="text-[13px] text-fg-dim max-w-sm">它可能已经被删除,或者属于另一个账号。</p>
      <Link to="/home" className="px-3.5 py-2 rounded-lg bg-fg text-ink text-[12.5px] font-medium">回到首页</Link>
    </div>
  )
}
