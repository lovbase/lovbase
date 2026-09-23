import { useMemo, useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Folder, Loader2, MoreHorizontal, Plus, Star } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { getProjects, newProject, projectMove, projectStar, removeProject } from '../functions'
import { Sidebar } from '../components/Sidebar'
import { Avatar } from '../components/Avatar'
import { timeAgo } from '@lovbase/core/time'
import { Cover } from '../components/Cover'
import { useI18n, useT } from '../lib/i18n'
import { useDialogs } from '../components/Dialogs'
import { track } from '../lib/posthog'

export const Route = createFileRoute('/projects/')({
  validateSearch: (s: Record<string, unknown>): { view?: string } => (typeof s.view === 'string' && s.view ? { view: s.view } : {}),
  loader: () => getProjects(),
  component: Projects,
  head: () => ({ meta: [{ title: 'Projects · Lovbase' }] }),
})

function Projects() {
  const t = useT()
  const dialogs = useDialogs()
  const { locale } = useI18n()
  const { user, projects, folders, limit, credits } = Route.useLoaderData()
  const { view = 'all' } = Route.useSearch()
  const router = useRouter()
  const create = useServerFn(newProject)
  const remove = useServerFn(removeProject)
  const move = useServerFn(projectMove)
  const star = useServerFn(projectStar)
  const [busy, setBusy] = useState(false)
  // Which cards are being deleted. The dialog closes the moment it is answered, so the waiting has
  // to happen where the thing itself is: the card spins in place and stops taking clicks.
  const [deleting, setDeleting] = useState<string[]>([])
  const [limitMsg, setLimitMsg] = useState('')
  const folderName = view.startsWith('folder:') ? folders.find((f) => f.id === view.slice(7))?.name : null
  const title = view === 'starred' ? t('nav.starred', 'Starred') : view === 'mine' ? t('nav.mine', 'Created by me') : folderName ?? t('nav.allProjects', 'All projects')
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
  async function del(id: string, name: string) {
    const ok = await dialogs.confirm({
      title: t('projects.deleteTitle', 'Delete the project "{name}"?').replace('{name}', name),
      description: t('projects.deleteDesc', 'Every table and all the data are deleted. This cannot be undone.'),
      confirmLabel: t('projects.delete', 'Delete'), destructive: true,
    })
    if (!ok) return
    setDeleting((d) => [...d, id])
    try {
      await remove({ data: { projectId: id } })
      await router.invalidate()
    } catch (e) {
      await dialogs.alert({ title: t('projects.deleteFailed', 'Delete failed'), description: e instanceof Error ? e.message : String(e) })
    } finally {
      // The row is gone after a successful invalidate; this is what puts it back on a failure.
      setDeleting((d) => d.filter((x) => x !== id))
    }
  }

  return (
    <div className="min-h-screen bg-ink text-fg antialiased flex">
      <Sidebar user={user} credits={credits} projects={projects} folders={folders} used={projects.length} limit={limit} active="projects" view={view} />
      <main className="flex-1 min-w-0 m-2 sm:ml-0 panel-card flex flex-col overflow-hidden">
        {/* pt on small screens is the room the floating menu button needs; the rail gives it on a
            desktop by simply not being on top of anything. */}
        <div className="max-w-5xl w-full mx-auto px-4 sm:px-8 pt-14 sm:pt-0 pb-16 overflow-y-auto">
          <div className="flex items-end justify-between mb-6">
            <div>
              <h1 className="font-display text-[24px] font-semibold flex items-center gap-2">{folderName && <Folder className="size-5 text-fg-dim" />}{title}</h1>
              <p className="text-fg-dim text-[13px] mt-1 tabular-nums">{shown.length} {t('nav.projectsUnit', 'projects')} · {projects.length} / {limit}</p>
            </div>
            <button onClick={add} disabled={busy}
              className="flex items-center gap-1.5 px-3.5 py-2 bg-accent text-on-accent rounded-lg text-[13px] font-medium hover:bg-accent-soft disabled:opacity-50 transition-colors cursor-pointer">
              <Plus className="size-4" /> {t('projects.new', 'New project')}
            </button>
          </div>
          {limitMsg && <p className="mb-4 text-[13px] text-fg-mid border border-edge rounded-lg px-4 py-3 bg-ink">{limitMsg}{t('projects.limitHint', '. See Pro on the account page.')}</p>}
          {shown.length === 0 ? (
            <div className="border border-dashed border-edge-strong rounded-xl py-14 text-center">
              <p className="text-fg-mid text-[14px]">{projects.length === 0 ? t('projects.emptyAll', 'No projects yet') : t('projects.emptyFiltered', 'Nothing here')}</p>
              <p className="text-fg-dim text-[12.5px] mt-1">{projects.length === 0 ? t('projects.emptyHint', 'Start from a template on the home page, or just describe the app you want.') : t('projects.emptyFilteredHint', 'Try another filter, or move a project in.')}</p>
            </div>
          ) : (
            /* No card at rest: the thumbnails are the content, and a border around each one turns
               a wall of them into a grid of boxes. The tray appears under the cursor, which is the
               only moment a card needs to say where its edges are. */
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1 -mx-2">
              {shown.map((p) => {
                const going = deleting.includes(p.id)
                return (
                <li key={p.id} aria-busy={going}
                  className={`group relative rounded-2xl p-2 transition-colors ${going ? 'pointer-events-none' : 'hover:bg-panel-2'}`}>
                  <Link to="/projects/$projectId" params={{ projectId: p.id }} className="block">
                    <div className="relative">
                      <Cover src={p.cover} name={p.name || t('builder.untitled', 'Untitled project')} tables={p.tables} />
                      {going && (
                        <div className="absolute inset-0 grid place-items-center rounded-xl bg-ink/70">
                          <Loader2 className="size-5 animate-spin text-fg-mid" />
                        </div>
                      )}
                    </div>
                    <div className={`pt-3 px-1 flex items-start gap-2.5 transition-opacity ${going ? 'opacity-45' : ''}`}>
                      <Avatar src={user.image} seed={user.email} name={user.name || user.email} size={28} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          {p.starred && <Star className="size-3.5 fill-fg text-fg shrink-0" />}
                          <span className="text-[15px] font-medium truncate">{p.name || t('builder.untitled', 'Untitled project')}</span>
                          {p.shared && <span className="text-[10.5px] px-1.5 py-px rounded border border-edge text-fg-dim shrink-0">{t('projects.shared', 'Shared')}</span>}
                        </div>
                        <p className="text-fg-dim text-[12px] mt-0.5" title={new Date(p.updated_at).toLocaleString()}>
                          {going ? t('projects.deleting', 'Deleting…') : <>{p.entities} {t('projects.tables', 'tables')} · {timeAgo(p.updated_at, locale === 'en' ? 'en' : 'zh-CN')}</>}
                        </p>
                      </div>
                    </div>
                  </Link>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<button className="absolute bottom-4 right-3 size-7 grid place-items-center rounded-lg text-fg-dim opacity-0 group-hover:opacity-100 data-[popup-open]:opacity-100 hover:text-fg hover:bg-panel transition-opacity cursor-pointer" />}>
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem onClick={() => star({ data: { projectId: p.id, starred: !p.starred } }).then(() => router.invalidate())}><Star className="size-4" /> {p.starred ? t('projects.unstar', 'Remove from starred') : t('nav.starred', 'Starred')}</DropdownMenuItem>
                      {/* No folders, no folder section: a menu row that only says "there is nothing here" is noise. */}
                      {folders.length > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          {folders.map((f) => (
                            <DropdownMenuItem key={f.id} disabled={p.folderId === f.id} onClick={() => move({ data: { projectId: p.id, folderId: f.id } }).then(() => router.invalidate())}><Folder className="size-4" /> {t('projects.moveTo', 'Move to "{name}"').replace('{name}', f.name)}</DropdownMenuItem>
                          ))}
                          {p.folderId && <DropdownMenuItem onClick={() => move({ data: { projectId: p.id, folderId: null } }).then(() => router.invalidate())}>{t('projects.moveOut', 'Move out of folder')}</DropdownMenuItem>}
                        </>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => del(p.id, p.name || t('builder.untitled', 'Untitled project'))} className="text-destructive">{t('projects.deleteProject', 'Delete project')}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
                )
              })}
            </ul>
          )}
        </div>
      </main>

    </div>
  )
}
