import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import type { IR } from '@lovbase/core/ir'
import { agentPreview, appDelete, appRename, type getProjectState } from '../functions'

/** How long a hidden tab keeps its live preview — and with it, a container — before letting go. */
const HIDDEN_IDLE_MS = 60_000
/** ...and how long an open tab does, with nobody typing, clicking or scrolling in it. */
const OPEN_IDLE_MS = 10 * 60_000
/** How often idleness is checked. Coarse on purpose: this decides a sleep, not a frame. */
const IDLE_TICK_MS = 15_000
import { useRouter } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyArt, LogoLoader, PreviewFrame, SleepingArt } from './PreviewState'
import { useT } from '../lib/i18n'
import { useDialogs } from './Dialogs'

// Loaded when first shown, not with the page. The code pane carries CodeMirror and five language
// grammars, and none of it is needed to watch an app being built — which is what the page opens
// on, and what the person is waiting for.
const DatabasePane = lazy(() => import('./DatabasePane').then((m) => ({ default: m.DatabasePane })))
const CodePane = lazy(() => import('./CodePane').then((m) => ({ default: m.CodePane })))
const AnalyticsPane = lazy(() => import('./AnalyticsPane').then((m) => ({ default: m.AnalyticsPane })))

type State = Awaited<ReturnType<typeof getProjectState>>
export type Pane = 'preview' | 'database' | 'code' | 'analytics'
/** A request from the chat to show something on the right (Manus-style "look at the computer"). `n` makes repeats distinct. */
export type Focus = { pane: Pane; file?: string; n: number }
const PANES: { value: Pane; label: string; key: string }[] = [
  { value: 'preview', label: '预览', key: 'pane.preview' }, { value: 'database', label: '数据库', key: 'pane.database' },
  { value: 'code', label: '代码', key: 'pane.code' }, { value: 'analytics', label: '分析', key: 'pane.analytics' },
]

// Creating extra apps is not offered here. Each app gets its own sandbox container — the runner
// addresses them by appId and the workspace inside is a single fixed path — while the container
// cap is the platform's scarcest resource. Apps had no limit, so the one thing that consumed it
// was the one thing nothing bounded. The model, the switcher and the existing apps stay; only
// the unbounded entry point is gone, so this is a door to reopen behind a plan limit rather
// than a feature to rebuild.
/** Right-hand work area: toolbar + the selected pane. Mirrors an editor's preview column. */
export function Workspace({ state, appId, previewUrl, onPreviewUrl, refreshKey = 0, onSelectApp, focus, building }: {
  state: State; appId: string; previewUrl: string; onPreviewUrl: (u: string) => void; refreshKey?: number; onSelectApp: (id: string) => void; focus?: Focus | null
  /** A build is running in the chat. Until now this pane had no state for it, so the whole two to
   *  five minutes of a first build looked identical to an empty project that nothing had happened to. */
  building?: boolean
}) {
  const t = useT()
  const dialogs = useDialogs()
  const projectId = state.project.id
  const router = useRouter()
  const renameA = useServerFn(appRename)
  const deleteA = useServerFn(appDelete)
  const app = state.apps.find((a) => a.id === appId) ?? state.apps[0]
  const [pane, setPane] = useState<Pane>('preview')
  const [nonce, setNonce] = useState(0)
  useEffect(() => { if (focus) setPane(focus.pane) }, [focus?.n])
  useEffect(() => { if (refreshKey) { setLive(true); setNonce((n) => n + 1) } }, [refreshKey])
  const [booting, setBooting] = useState(false)
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState('')
  const preview = useServerFn(agentPreview)

  // Opening an app should not need a container. Booting one to render what is already built costs
  // two to five minutes of spinner, so a copy that answers immediately is what opens and the
  // sandbox starts only when something has to be live.
  //
  // Two such copies: the build snapshot kept after every turn, and the published app. Both are
  // stills, and the moment the code moves they stop being the truth — so anything that changes the
  // app switches to live on its own. Someone who edits, sees no change, and concludes the product
  // is broken is a worse outcome than a slow boot.
  //
  // Newest first, which puts the build snapshot ahead of the published copy: publishing is a
  // moment someone chose, and every build since is later than it. Showing the published one over
  // a newer build would answer "what does my app look like" with a version they had moved past.
  // Which of the three is on screen is not a question to put to anybody — the pane shows the
  // newest thing it can reach, and upgrades itself as better ones become reachable.
  const restUrl = app?.snapUrl ?? app?.url ?? ''
  const [live, setLive] = useState(!restUrl)
  useEffect(() => {
    const a = state.apps.find((x) => x.id === appId)
    setLive(!(a?.snapUrl ?? a?.url))
  }, [appId])
  useEffect(() => { if (building) setLive(true) }, [building])
  const showingRest = !live && !!restUrl
  const shownUrl = showingRest ? restUrl : previewUrl

  // Having a URL is not the same as there being anything at it. The container answers as soon as
  // its host resolves, while the dev server inside is still installing and cold-starting, so the
  // iframe would mount onto an empty shell and sit there white — no spinner, no explanation, just
  // a blank rectangle where the app should be. The frame loads behind the waking state and only
  // comes forward once it has actually loaded something.
  const [frameLoaded, setFrameLoaded] = useState(false)
  useEffect(() => { setFrameLoaded(false) }, [shownUrl, nonce])

  async function openPreview() {
    setBooting(true); setErr('')
    try {
      const r = await preview({ data: { projectId, appId } })
      onPreviewUrl(r.previewUrl)
      // No URL is not readiness. Treating it as ready renders an iframe pointed at nothing.
      setReady(!!r.previewUrl)
      if (!r.previewUrl) setErr('预览没能启动,请稍后重试')
      setNonce((n) => n + 1)
    }
    catch (e) { setReady(false); setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBooting(false) }
  }

  const hasSchema = state.ir.entities.length > 0
  // An app is previewable once anything has been generated for it, with or without tables.
  const hasApp = hasSchema || !!state.apps.find((a) => a.id === appId)?.built
  // A stored preview URL cannot be trusted: the container sleeps after a few idle minutes and its
  // host stops answering, which used to surface as the sandbox's raw JSON error inside the iframe.
  // Re-boot on entering the pane instead — the call is idempotent and also restores the source.
  const booted = useRef<string>('')
  useEffect(() => {
    if (pane !== 'preview' || !hasApp || booting || !live) return
    if (booted.current === appId) return
    booted.current = appId
    setReady(false)
    openPreview()
  }, [pane, hasApp, appId, live])

  /**
   * Let go of the container when nobody is using it.
   *
   * A live preview is a dev server with an open HMR socket, and the sandbox renews its idle timer
   * on traffic — so the thing meant to put a container to sleep after five minutes never fires
   * while a tab sits open on the preview. An open tab therefore bills for a container nobody is
   * using, and holds one of the two slots the whole product shares.
   *
   * Two idles, because they mean different things. A hidden tab is nobody looking, and a minute is
   * enough to say so. A visible tab with no input is somebody who has moved on without closing
   * anything, which takes longer to be sure of.
   *
   * Never during a build. A task that is running must not be cut short to save a container, and it
   * would not save one anyway — the build's own polling keeps that container awake regardless.
   *
   * The limit worth knowing: the preview is a cross-origin iframe, so clicks *inside* the
   * generated app are invisible here. Focus sitting on the frame is the only signal that reaches
   * us, and it is the one used. Someone watching an animation without touching anything for ten
   * minutes will be let go, and one click brings it back.
   */
  useEffect(() => {
    if (!live || building) return
    const frame = () => document.activeElement?.tagName === 'IFRAME'
    let last = Date.now()
    const touched = () => { last = Date.now() }
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const
    for (const e of events) document.addEventListener(e, touched, { passive: true })
    document.addEventListener('visibilitychange', touched)

    const id = setInterval(() => {
      if (frame()) return touched()
      const idleFor = Date.now() - last
      const limit = document.visibilityState === 'hidden' ? HIDDEN_IDLE_MS : OPEN_IDLE_MS
      if (idleFor < limit) return
      setReady(false)
      // So re-entering the pane boots a fresh container rather than trusting a host that has
      // since stopped answering.
      booted.current = ''
      if (restUrl) setLive(false)
    }, IDLE_TICK_MS)

    return () => {
      clearInterval(id)
      for (const e of events) document.removeEventListener(e, touched)
      document.removeEventListener('visibilitychange', touched)
    }
  }, [live, building, restUrl])
  const showingApp = pane === 'preview' && (showingRest || (ready && !!previewUrl))
  return (
    <div className="h-full flex flex-col min-w-0">
      {/* Everything in this bar has a job, and at 375px they do not all fit. Rather than dropping
          controls, the bar scrolls and the URL field — the one thing that is only ever read — is
          the part that gives up its space first. */}
      <div className="h-11 shrink-0 flex items-center gap-2 px-3 border-b border-edge bg-panel/40 overflow-x-auto">
        <div className="flex items-center rounded-lg border border-edge bg-panel p-0.5">
          {PANES.map((p) => (
            <button key={p.value} onClick={() => setPane(p.value)}
              className={`px-3 py-1 rounded-md text-[12.5px] transition-colors cursor-pointer ${
                pane === p.value ? 'bg-panel-2 text-fg shadow-sm' : 'text-fg-dim hover:text-fg'
              }`}>
              {t(p.key, p.label)}
            </button>
          ))}
        </div>
        {pane === 'preview' && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger render={<button className="h-8 flex items-center gap-1.5 px-2.5 rounded-lg border border-edge bg-panel text-[12.5px] text-fg hover:border-edge-strong transition-colors cursor-pointer max-w-[12rem]" />}>
                <span className="truncate">{app?.name ?? '应用'}</span><ChevronDown className="size-3.5 text-fg-dim shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                {state.apps.map((a) => (
                  <DropdownMenuItem key={a.id} onClick={() => onSelectApp(a.id)} className={a.id === appId ? 'bg-panel-2' : ''}>{a.name}</DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                {app && <DropdownMenuItem onClick={async () => { const n = await dialogs.prompt({ title: '重命名应用', label: '名称', defaultValue: app.name }); if (n?.trim()) renameA({ data: { projectId, appId: app.id, name: n } }).then(() => router.invalidate()) }}>重命名「{app.name}」</DropdownMenuItem>}
                {app && state.apps.length > 1 && <DropdownMenuItem className="text-destructive" onClick={async () => { if (await dialogs.confirm({ title: `删除应用「${app.name}」?`, description: '代码会丢失,数据不受影响。', confirmLabel: '删除', destructive: true })) deleteA({ data: { projectId, appId: app.id } }).then(() => { router.invalidate(); onSelectApp(state.apps.find((a) => a.id !== app.id)!.id) }) }}>删除「{app.name}」</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
            {/* One button, one meaning: show me the newest. From a still that means starting the
                sandbox, from the sandbox it means reloading it — a distinction the person pressing
                it has no reason to hold. */}
            <button onClick={() => { if (showingRest) return setLive(true); return previewUrl ? setNonce((n) => n + 1) : openPreview() }} disabled={booting}
              title={t('preview.refresh', '刷新预览')}
              className="size-8 grid place-items-center rounded-lg border border-edge text-fg-dim hover:text-fg hover:border-edge-strong disabled:opacity-40 transition-colors cursor-pointer">
              <RefreshIcon spinning={booting} />
            </button>
            <div className="flex-1 min-w-0 mx-1 max-sm:hidden">
              <div className="h-8 flex items-center gap-2 rounded-lg border border-edge bg-panel px-3">
                <span className="flex-1 min-w-0 text-center font-mono text-[11.5px] text-fg-dim truncate">
                  {shownUrl ? shownUrl.replace(/^https?:\/\//, '') : hasApp ? '正在准备预览…' : '先在左边描述你想要的应用'}
                </span>
              </div>
            </div>
            {shownUrl && (
              <a href={shownUrl} target="_blank" rel="noreferrer" title="新窗口打开"
                className="size-8 grid place-items-center rounded-lg border border-edge text-fg-dim hover:text-fg hover:border-edge-strong transition-colors">
                <ExternalIcon />
              </a>
            )}
          </>
        )}
        {pane !== 'preview' && <div className="flex-1" />}
        {/* Without this the scrolling bar has nothing to push against and the buttons bunch up. */}
        <div className="shrink-0 w-px max-sm:w-2" />
      </div>

      {/* `paper` is the surface a generated app sits on, and it stays light in the dark theme
          because generated apps are light. Our own panes are not: on paper their text is the
          theme's light ink on a light ground, which in dark mode is invisible. So the paper is
          only under the iframe. */}
      <div className={`flex-1 min-h-0 ${showingApp ? 'bg-paper' : 'bg-panel'}`}>
        {pane === 'preview' && (showingRest || (ready && previewUrl)
          ? (
            <div className="relative w-full h-full">
              <iframe key={showingRest ? `${appId}-rest` : `${appId}-${nonce}`} src={shownUrl}
                onLoad={() => setFrameLoaded(true)} title="preview"
                className={`w-full h-full border-0 bg-white transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none ${frameLoaded ? 'opacity-100 scale-100' : 'opacity-0 scale-[.99]'}`} />
              {!frameLoaded && (
                <div className="absolute inset-0 bg-panel">
                  <PreviewFrame art={<LogoLoader />}
                    title={showingRest ? t('preview.loading.title', '正在加载上次构建') : t('preview.waking.title', '正在启动预览')} />
                </div>
              )}
            </div>
          )
          : building
            ? <PreviewFrame art={<LogoLoader />} title={t('preview.building.title', '正在生成界面')} />
          : !hasApp
            ? <PreviewFrame art={<EmptyArt />} title={t('preview.empty.title', '还没有可预览的内容')} />
            : booting
              ? <PreviewFrame art={<LogoLoader />} title={t('preview.waking.title', '正在启动预览')} error={err} />
              : <PreviewFrame art={<SleepingArt />} title={t('preview.asleep.title', '预览已休眠')}
                  error={err}
                  action={
                    <button onClick={openPreview}
                      className="px-3.5 py-2 rounded-lg bg-fg text-ink text-[12.5px] font-medium cursor-pointer">
                      {t('preview.wake', '唤醒预览')}
                    </button>
                  } />
        )}
        <Suspense fallback={<div className="h-full grid place-items-center"><LogoLoader size={32} /></div>}>
          {pane === 'database' && <DatabasePane projectId={projectId} apiToken={state.project.apiToken} refreshKey={state.ir.entities.length} />}
          {pane === 'analytics' && <AnalyticsPane projectId={projectId} />}
          {pane === 'code' && <CodePane key={appId} projectId={projectId} appId={appId} ir={state.ir as IR} ddl={state.ddl} onSaved={() => setNonce((n) => n + 1)} openFile={focus?.pane === 'code' ? focus : null} />}
        </Suspense>
      </div>
    </div>
  )
}

const RefreshIcon = ({ spinning }: { spinning?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={spinning ? 'animate-spin' : ''}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 2.5v3h-3" />
  </svg>
)
const ExternalIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M7 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9" /><path d="M9 2h5v5M14 2 7.5 8.5" />
  </svg>
)
