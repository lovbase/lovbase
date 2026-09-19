import { useEffect, useRef, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import type { IR } from '@lovbase/core/ir'
import { agentPreview, appCreate, appDelete, appRename, type getProjectState } from '../functions'
import { useRouter } from '@tanstack/react-router'
import { ChevronDown, Plus } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { DatabasePane } from './DatabasePane'
import { CodePane } from './CodePane'
import { EmptyArt, LogoLoader, PreviewFrame, SleepingArt } from './PreviewState'
import { useT } from '../lib/i18n'
import { AnalyticsPane } from './AnalyticsPane'

type State = Awaited<ReturnType<typeof getProjectState>>
export type Pane = 'preview' | 'database' | 'code' | 'analytics'
/** A request from the chat to show something on the right (Manus-style "look at the computer"). `n` makes repeats distinct. */
export type Focus = { pane: Pane; file?: string; n: number }
const PANES: { value: Pane; label: string; key: string }[] = [
  { value: 'preview', label: '预览', key: 'pane.preview' }, { value: 'database', label: '数据库', key: 'pane.database' },
  { value: 'code', label: '代码', key: 'pane.code' }, { value: 'analytics', label: '分析', key: 'pane.analytics' },
]

/** Right-hand work area: toolbar + the selected pane. Mirrors an editor's preview column. */
export function Workspace({ state, appId, previewUrl, onPreviewUrl, refreshKey = 0, onSelectApp, focus, building }: {
  state: State; appId: string; previewUrl: string; onPreviewUrl: (u: string) => void; refreshKey?: number; onSelectApp: (id: string) => void; focus?: Focus | null
  /** A build is running in the chat. Until now this pane had no state for it, so the whole two to
   *  five minutes of a first build looked identical to an empty project that nothing had happened to. */
  building?: boolean
}) {
  const t = useT()
  const projectId = state.project.id
  const router = useRouter()
  const createA = useServerFn(appCreate)
  const renameA = useServerFn(appRename)
  const deleteA = useServerFn(appDelete)
  const app = state.apps.find((a) => a.id === appId) ?? state.apps[0]
  const [pane, setPane] = useState<Pane>('preview')
  const [nonce, setNonce] = useState(0)
  useEffect(() => { if (focus) setPane(focus.pane) }, [focus?.n])
  useEffect(() => { if (refreshKey) setNonce((n) => n + 1) }, [refreshKey])
  const [booting, setBooting] = useState(false)
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState('')
  const preview = useServerFn(agentPreview)

  async function openPreview() {
    setBooting(true); setErr('')
    try { const r = await preview({ data: { projectId, appId } }); onPreviewUrl(r.previewUrl); setReady(true); setNonce((n) => n + 1) }
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
    if (pane !== 'preview' || !hasApp || booting) return
    if (booted.current === appId) return
    booted.current = appId
    setReady(false)
    openPreview()
  }, [pane, hasApp, appId])
  async function newApp() {
    const name = prompt('新应用的名字', '新应用')
    if (!name) return
    const a = await createA({ data: { projectId, name } })
    await router.invalidate(); onSelectApp(a.id)
  }
  return (
    <div className="h-full flex flex-col min-w-0">
      <div className="h-11 shrink-0 flex items-center gap-2 px-3 border-b border-edge bg-panel/40">
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
                <DropdownMenuItem onClick={newApp}><Plus className="size-4" /> 新建应用</DropdownMenuItem>
                {app && <DropdownMenuItem onClick={() => { const n = prompt('重命名应用', app.name); if (n?.trim()) renameA({ data: { projectId, appId: app.id, name: n } }).then(() => router.invalidate()) }}>重命名「{app.name}」</DropdownMenuItem>}
                {app && state.apps.length > 1 && <DropdownMenuItem className="text-destructive" onClick={() => { if (confirm(`删除应用「${app.name}」?代码会丢失,数据不受影响。`)) deleteA({ data: { projectId, appId: app.id } }).then(() => { router.invalidate(); onSelectApp(state.apps.find((a) => a.id !== app.id)!.id) }) }}>删除「{app.name}」</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
            <button onClick={() => (previewUrl ? setNonce((n) => n + 1) : openPreview())} disabled={booting}
              title="刷新预览" className="size-8 grid place-items-center rounded-lg border border-edge text-fg-dim hover:text-fg hover:border-edge-strong disabled:opacity-40 transition-colors cursor-pointer">
              <RefreshIcon spinning={booting} />
            </button>
            <div className="flex-1 min-w-0 mx-1">
              <div className="h-8 flex items-center justify-center rounded-lg border border-edge bg-panel font-mono text-[11.5px] text-fg-dim truncate px-3">
                {previewUrl ? previewUrl.replace(/^https?:\/\//, '') : hasApp ? '正在准备预览…' : '先在左边描述你想要的应用'}
              </div>
            </div>
            {previewUrl && (
              <a href={previewUrl} target="_blank" rel="noreferrer" title="新窗口打开"
                className="size-8 grid place-items-center rounded-lg border border-edge text-fg-dim hover:text-fg hover:border-edge-strong transition-colors">
                <ExternalIcon />
              </a>
            )}
          </>
        )}
        {pane !== 'preview' && <div className="flex-1" />}
      </div>

      <div className="flex-1 min-h-0 bg-paper">
        {pane === 'preview' && (ready
          ? <iframe key={`${appId}-${nonce}`} src={previewUrl} title="preview" className="w-full h-full border-0 bg-white" />
          : building
            ? <PreviewFrame art={<LogoLoader />} title={t('preview.building.title', '正在生成界面')}
                hint={t('preview.building.hint', 'agent 在沙箱里写代码,通常两到五分钟。左边能看到它正在改哪个文件。')} />
          : !hasApp
            ? <PreviewFrame art={<EmptyArt />} title={t('preview.empty.title', '还没有可预览的内容')}
                hint={t('preview.empty.hint', '在左边用一句话描述你要的应用。需要存数据的,agent 会先建表;不需要的直接生成界面。')} />
            : booting
              ? <PreviewFrame art={<LogoLoader />} title={t('preview.waking.title', '正在唤醒沙箱')}
                  hint={t('preview.waking.hint', '容器闲置一段时间会自动休眠。首次启动要装依赖,大约 20 到 60 秒。')} error={err} />
              : <PreviewFrame art={<SleepingArt />} title={t('preview.asleep.title', '预览已休眠')}
                  hint={t('preview.asleep.hint', '沙箱在闲置后回收了容器。你的代码和数据都在,唤醒后会自动恢复。')}
                  error={err}
                  action={
                    <button onClick={openPreview}
                      className="px-3.5 py-2 rounded-lg bg-fg text-ink text-[12.5px] font-medium cursor-pointer">
                      {t('preview.wake', '唤醒预览')}
                    </button>
                  } />
        )}
        {pane === 'database' && <DatabasePane projectId={projectId} apiToken={state.project.apiToken} refreshKey={state.ir.entities.length} />}
        {pane === 'analytics' && <AnalyticsPane projectId={projectId} />}
        {pane === 'code' && <CodePane key={appId} projectId={projectId} appId={appId} ir={state.ir as IR} ddl={state.ddl} onSaved={() => setNonce((n) => n + 1)} openFile={focus?.pane === 'code' ? focus : null} />}
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
