import { useMemo, useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Folder, MoreHorizontal, Plus, Star } from 'lucide-react'
import { AlertDialog } from '@base-ui-components/react/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { getProjects, newProject, projectMove, projectStar, removeProject } from '../functions'
import { Sidebar } from '../components/Sidebar'
import { Avatar } from '../components/Avatar'
import { timeAgo } from '@lovbase/core/time'
import { MiniApp } from '../components/MiniApp'
import { useI18n, useT } from '../lib/i18n'
import { track } from '../lib/posthog'

export const Route = createFileRoute('/projects/')({
  validateSearch: (s: Record<string, unknown>): { view?: string } => (typeof s.view === 'string' && s.view ? { view: s.view } : {}),
  loader: () => getProjects(),
  component: Projects,
  head: () => ({ meta: [{ title: '项目 · Lovbase' }] }),
})

function Projects() {
  const t = useT()
  const { locale } = useI18n()
  const { user, projects, folders, limit, credits } = Route.useLoaderData()
  const { view = 'all' } = Route.useSearch()
  const router = useRouter()
  const create = useServerFn(newProject)
  const remove = useServerFn(removeProject)
  const move = useServerFn(projectMove)
  const star = useServerFn(projectStar)
  const [busy, setBusy] = useState(false)
  const [victim, setVictim] = useState<{ id: string; name: string } | null>(null)
  const [limitMsg, setLimitMsg] = useState('')
  const folderName = view.startsWith('folder:') ? folders.find((f) => f.id === view.slice(7))?.name : null
  const title = view === 'starred' ? t('nav.starred', '收藏') : view === 'mine' ? t('nav.mine', '我创建的') : folderName ?? t('nav.allProjects', '全部项目')
  const shown = useMemo(() => projects.filter((p) => {
    if (view === 'starred' && !p.starred) return false
    if (view.startsWith('folder:') && p.folderId !== view.slice(7)) return false
    return true
  }), [projects, view])

  async function add() {
    setBusy(true); setLimitMsg('')
    try { const { id } = await create(); track('project_created', { fromPrompt: false }); router.navigate({ to: '/projects/$projectId', params: { projectId: id } }) }
    catch (e) { setLimitMsg(e instanceof Error ? e.message.replace('LIMIT:', '') : String(e)) }
    finally { setBusy(false) }
  }
  async function del() {
    if (!victim) return
    setBusy(true)
    try { await remove({ data: { projectId: victim.id } }) } finally { setVictim(null); setBusy(false); router.invalidate() }
  }

  return (
    <div className="min-h-screen bg-ink text-fg antialiased flex">
      <Sidebar user={user} credits={credits} projects={projects} folders={folders} used={projects.length} limit={limit} active="projects" view={view} />
      <main className="flex-1 min-w-0 m-2 ml-0 rounded-2xl border border-edge bg-panel shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_-12px_rgba(0,0,0,.12)] flex flex-col overflow-hidden">
        <div className="max-w-5xl w-full mx-auto px-8 pb-16 overflow-y-auto">
          <div className="flex items-end justify-between mb-6">
            <div>
              <h1 className="font-display text-[24px] font-semibold flex items-center gap-2">{folderName && <Folder className="size-5 text-fg-dim" />}{title}</h1>
              <p className="text-fg-dim text-[13px] mt-1 tabular-nums">{shown.length} {t('nav.projectsUnit', '个项目')} · {projects.length} / {limit}</p>
            </div>
            <button onClick={add} disabled={busy}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-accent text-on-accent rounded-lg text-[13px] font-medium hover:bg-accent-soft disabled:opacity-50 transition-colors cursor-pointer">
              <Plus className="size-4" /> {t('projects.new', '新建项目')}
            </button>
          </div>
          {limitMsg && <p className="mb-4 text-[13px] text-fg-mid border border-edge rounded-lg px-4 py-3 bg-ink">{limitMsg}{t('projects.limitHint', '。到账户页了解 Pro。')}</p>}
          {shown.length === 0 ? (
            <div className="border border-dashed border-edge-strong rounded-xl py-14 text-center">
              <p className="text-fg-mid text-[14px]">{projects.length === 0 ? t('projects.emptyAll', '还没有项目') : t('projects.emptyFiltered', '这里没有项目')}</p>
              <p className="text-fg-dim text-[12.5px] mt-1">{projects.length === 0 ? t('projects.emptyHint', '回首页从一个模板开始,或直接描述你要的应用') : t('projects.emptyFilteredHint', '换个筛选,或把项目移进来')}</p>
            </div>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {shown.map((p) => (
                <li key={p.id} className="group relative">
                  <Link to="/projects/$projectId" params={{ projectId: p.id }}
                    className="block bg-panel border border-edge rounded-xl overflow-hidden hover:border-edge-strong hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/5 transition-all">
                    <MiniApp name={p.name || t('builder.untitled', '未命名项目')} tables={p.tables} />
                    <div className="p-4 flex items-start gap-2.5">
                      <Avatar src={user.image} seed={user.email} name={user.name || user.email} size={28} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          {p.starred && <Star className="size-3.5 fill-fg text-fg shrink-0" />}
                          <span className="text-[15px] font-medium truncate">{p.name || t('builder.untitled', '未命名项目')}</span>
                          {p.shared && <span className="text-[10.5px] px-1.5 py-px rounded border border-edge text-fg-dim shrink-0">{t('projects.shared', '已分享')}</span>}
                        </div>
                        <p className="text-fg-dim text-[12px] mt-0.5" title={new Date(p.updated_at).toLocaleString()}>
                          {p.entities} {t('projects.tables', '张表')} · {timeAgo(p.updated_at, locale === 'en' ? 'en' : 'zh-CN')}
                        </p>
                      </div>
                    </div>
                  </Link>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<button className="absolute top-2.5 right-2.5 size-7 grid place-items-center rounded-md bg-panel/80 border border-edge text-fg-dim opacity-0 group-hover:opacity-100 data-[popup-open]:opacity-100 hover:text-fg transition-opacity cursor-pointer" />}>
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem onClick={() => star({ data: { projectId: p.id, starred: !p.starred } }).then(() => router.invalidate())}><Star className="size-4" /> {p.starred ? t('projects.unstar', '取消收藏') : t('nav.starred', '收藏')}</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {folders.map((f) => (
                        <DropdownMenuItem key={f.id} disabled={p.folderId === f.id} onClick={() => move({ data: { projectId: p.id, folderId: f.id } }).then(() => router.invalidate())}><Folder className="size-4" /> 移到「{f.name}」</DropdownMenuItem>
                      ))}
                      {p.folderId && <DropdownMenuItem onClick={() => move({ data: { projectId: p.id, folderId: null } }).then(() => router.invalidate())}>移出文件夹</DropdownMenuItem>}
                      {folders.length === 0 && <DropdownMenuItem disabled>还没有文件夹(在左侧栏新建)</DropdownMenuItem>}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setVictim({ id: p.id, name: p.name || '未命名项目' })} className="text-destructive">删除项目</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>

      <AlertDialog.Root open={!!victim} onOpenChange={(o) => !o && setVictim(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[2px]" />
          <AlertDialog.Popup className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[26rem] max-w-[calc(100vw-2rem)] bg-panel border border-edge-strong rounded-xl p-5 shadow-2xl">
            <AlertDialog.Title className="text-[11px] uppercase tracking-[.14em] text-fg-dim mb-2">删除项目</AlertDialog.Title>
            <AlertDialog.Description className="text-sm text-fg-mid">「{victim?.name}」的全部表和数据会被删除,不可恢复。</AlertDialog.Description>
            <div className="flex justify-end gap-2 mt-4">
              <AlertDialog.Close className="px-3.5 py-2 border border-edge rounded-lg text-[13px] text-fg-mid hover:text-fg hover:border-edge-strong transition-colors cursor-pointer">取消</AlertDialog.Close>
              <button onClick={del} disabled={busy} className="px-3.5 py-2 bg-accent text-on-accent rounded-lg text-[13px] font-medium hover:bg-accent-soft disabled:opacity-50 transition-colors cursor-pointer">删除</button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}
