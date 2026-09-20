import { useEffect, useState, type ReactNode } from 'react'
import { writeLayout } from '../lib/layout-prefs'
import { useLayout } from '../lib/layout-context'
import { Link, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import {
  ChevronDown, ChevronRight, ChevronsUpDown, Folder, FolderPlus, Home, LayoutGrid, LogOut, MoreHorizontal,
  PanelLeftClose, Search, ShieldCheck, Sparkles, Star, User, Zap,
} from 'lucide-react'
import { CommandPalette, type PaletteProject } from './CommandPalette'
import { folderCreate, folderDelete, folderRename } from '../functions'
import { planOf } from '@lovbase/core/plans'
import { useT } from '../lib/i18n'
import { LocaleToggle } from './LocaleToggle'
import { Logo } from './Logo'
import { signOut } from '../lib/auth-client'
import { identify, resetIdentity } from '../lib/posthog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type SidebarProject = PaletteProject & { folderId: string | null }
export type SidebarFolder = { id: string; name: string }
/** 'all' | 'starred' | 'mine' | 'folder:<id>' */
export type View = string

// ── Motion model (the shadcn Sidebar approach) ──
// Only the container width animates. Every row keeps the same left padding and icon position in both
// states; labels never wrap (nowrap + clip) and simply fade. Sub-lists fold via grid-rows so nothing
// below them jumps. Main content resizes in the same 200ms so the two motions read as one.
const EASE = 'duration-200 ease-[cubic-bezier(.2,0,0,1)] motion-reduce:transition-none'

/**
 * Folds its content by height; used for everything that only exists in the expanded state.
 *
 * Defined at module scope on purpose. Declared inside the component it is a new component type
 * on every render, so React unmounts the subtree and mounts a fresh one — the node has no
 * previous height to animate from and the transition never runs. The 1fr↔0fr grid trick was
 * already here; it just never got the chance.
 */
function Fold({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <div className={`grid transition-[grid-template-rows,opacity] ${EASE} ${show ? '[grid-template-rows:1fr] opacity-100' : '[grid-template-rows:0fr] opacity-0 pointer-events-none'}`}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

export function Sidebar({ user, credits, projects, folders, used, limit, active, view = 'all', onProject = false }: {
  user: { name: string; email: string; isAdmin?: boolean; plan?: string }
  credits?: { left: number; included: number; bonus: number; used: number; periodEnd?: string }
  projects: SidebarProject[]
  folders: SidebarFolder[]
  used: number
  limit: number
  active: 'home' | 'projects' | 'settings' | 'admin'
  view?: View
  onProject?: boolean
}) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const router = useRouter()
  const t = useT()
  // The sidebar renders on every signed-in page, so it is where the session becomes a person.
  useEffect(() => { identify({ id: user.email, email: user.email, plan: user.plan, isAdmin: user.isAdmin }) }, [user.email, user.plan])
  const planName = planOf(user.plan).name
  const canUpgrade = user.plan !== 'business'
  const createF = useServerFn(folderCreate)
  const renameF = useServerFn(folderRename)
  const deleteF = useServerFn(folderDelete)
  const layout = useLayout()
  const [open, setOpen] = useState(onProject ? layout.sidebarProject : layout.sidebar)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [editing, setEditing] = useState<{ id: string | 'new'; name: string } | null>(null)
  // Two fields, because the two contexts want different things: on a project page the preview is
  // the work and the rail starts collapsed, everywhere else the nav starts open. One shared field
  // would make collapsing here collapse the home page too. The value arrives from the cookie the
  // server already read, so the rail renders at its real width and nothing corrects it afterwards.
  const field = onProject ? 'sidebarProject' : 'sidebar'
  const toggle = () => setOpen((o) => { writeLayout({ [field]: !o }); return !o })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'b') { e.preventDefault(); toggle() } }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [])
  const initial = (user.name || user.email)[0]?.toUpperCase()

  async function commitEdit() {
    if (!editing) return
    const name = editing.name.trim()
    try {
      if (!name) return
      if (editing.id === 'new') await createF({ data: { name } })
      else await renameF({ data: { id: editing.id, name } })
      router.invalidate()
    } finally { setEditing(null) }
  }

  const isProjects = active === 'projects'
  // Fixed geometry: 8px gutter + 36px row = icons sit at x=8+10 in both states.
  const rowCls = (on: boolean) =>
    `group flex items-center gap-2.5 h-9 pl-2.5 pr-2 rounded-lg text-[13.5px] whitespace-nowrap overflow-hidden transition-colors ${
      on ? 'bg-panel-2 text-fg' : 'text-fg-mid hover:text-fg hover:bg-panel-2/70'}`
  const fade = `transition-opacity ${EASE} ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`
  const Row = ({ on, icon, text, to, search, onClick, right }: {
    on: boolean; icon: ReactNode; text: string; to?: string; search?: Record<string, string>; onClick?: () => void; right?: ReactNode
  }) => {
    const inner = <>{icon}<span className={`truncate ${fade}`}>{text}</span>{right && <span className={`ml-auto ${fade}`}>{right}</span>}</>
    const el = to
      ? <Link to={to as any} search={(search ?? {}) as any} className={rowCls(on)}>{inner}</Link>
      : <button onClick={onClick} className={`${rowCls(on)} w-full cursor-pointer`}>{inner}</button>
    return open ? el : (
      <Tooltip><TooltipTrigger render={<span className="block" />}>{el}</TooltipTrigger><TooltipContent side="right">{text}</TooltipContent></Tooltip>
    )
  }
  return (
    <>
    <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} projects={projects} isAdmin={!!user.isAdmin} ownerName={user.name || user.email} />
    <aside className={`shrink-0 h-screen sticky top-0 bg-ink flex flex-col overflow-hidden transition-[width] ${EASE} ${open ? 'w-64' : 'w-14'}`}>
      {/* brand row: logo fixed at the left; in the collapsed state the logo is the expand control */}
      <div className="h-14 flex items-center pl-3.5 pr-3 shrink-0">
        <button onClick={toggle} disabled={open} title={open ? undefined : '展开侧栏 (⌘B)'}
          className={`flex items-center rounded-lg ${open ? 'gap-2.5 cursor-default' : 'gap-0 cursor-pointer hover:bg-panel-2 -ml-1.5 p-1.5'}`}>
          <Logo />
          <span className={`text-[15px] font-semibold tracking-tight whitespace-nowrap overflow-hidden transition-all ${EASE} ${open ? 'opacity-100 max-w-[7rem]' : 'opacity-0 max-w-0 pointer-events-none'}`}>Lovbase</span>
        </button>
        <button onClick={toggle} title="收起侧栏 (⌘B)"
          className={`ml-auto size-8 grid place-items-center rounded-lg text-fg-dim hover:text-fg hover:bg-panel-2 transition-colors cursor-pointer ${fade}`}>
          <PanelLeftClose className="size-4" />
        </button>
      </div>

      <nav className="px-2 space-y-0.5">
        <Row on={active === 'home'} icon={<Home className="size-4 shrink-0" />} text={t('nav.home', '首页')} to="/home" />
        <Row on={false} icon={<Search className="size-4 shrink-0" />} text={t('nav.search', '搜索')} onClick={() => setPaletteOpen(true)}
          right={<kbd className="text-[10.5px] text-fg-dim border border-edge rounded px-1.5 py-px bg-panel">⌘K</kbd>} />
      </nav>

      <div className="px-2 mt-5 space-y-0.5 min-h-0 overflow-y-auto overflow-x-hidden">
        <Fold show={open}><p className="eyebrow px-2.5 mb-1.5">{t('nav.projects', '项目')}</p></Fold>
        <div className={`${rowCls(isProjects && view === 'all')} relative`}>
          <Link to="/projects" search={{}} className="absolute inset-0" aria-label={t('nav.allProjects', '全部项目')} />
          <LayoutGrid className="size-4 shrink-0 relative" />
          <span className={`truncate relative pointer-events-none ${fade}`}>{t('nav.allProjects', '全部项目')}</span>
          <span className={`ml-auto flex items-center gap-1 relative ${fade}`}>
            <button onClick={() => setEditing({ id: 'new', name: '' })} title="新建文件夹"
              className="opacity-0 group-hover:opacity-100 text-fg-dim hover:text-fg cursor-pointer p-0.5"><FolderPlus className="size-3.5" /></button>
            <button onClick={() => setProjectsOpen((o) => !o)} className="text-fg-dim hover:text-fg cursor-pointer p-0.5">
              {projectsOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          </span>
        </div>
        <Fold show={open && projectsOpen}>
          <div className="ml-4 pl-2 border-l border-edge space-y-0.5 py-0.5">
            {folders.length === 0 && editing?.id !== 'new' && (
              <button onClick={() => setEditing({ id: 'new', name: '' })} className="flex items-center gap-2 w-full px-2 py-1.5 text-[12.5px] text-fg-dim hover:text-fg cursor-pointer whitespace-nowrap">
                没有文件夹 <FolderPlus className="size-3.5 ml-auto" />
              </button>
            )}
            {folders.map((f) => editing?.id === f.id ? (
              <FolderInput key={f.id} value={editing.name} onChange={(name) => setEditing({ id: f.id, name })} onDone={commitEdit} onCancel={() => setEditing(null)} />
            ) : (
              <div key={f.id} className={`group/f flex items-center gap-2 rounded-md text-[13px] whitespace-nowrap ${view === `folder:${f.id}` ? 'bg-panel-2 text-fg' : 'text-fg-mid hover:text-fg hover:bg-panel-2/70'}`}>
                <Link to="/projects" search={{ view: `folder:${f.id}` }} className="flex items-center gap-2 flex-1 min-w-0 px-2 py-1.5"><Folder className="size-3.5 shrink-0" /><span className="truncate">{f.name}</span></Link>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<button className="opacity-0 group-hover/f:opacity-100 data-[popup-open]:opacity-100 mr-1 text-fg-dim hover:text-fg cursor-pointer" />}><MoreHorizontal className="size-3.5" /></DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => setEditing({ id: f.id, name: f.name })}>重命名</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => deleteF({ data: { id: f.id } }).then(() => router.invalidate())}>删除文件夹(项目保留)</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
            {editing?.id === 'new' && <FolderInput value={editing.name} onChange={(name) => setEditing({ id: 'new', name })} onDone={commitEdit} onCancel={() => setEditing(null)} />}
          </div>
        </Fold>
        <Row on={isProjects && view === 'starred'} icon={<Star className="size-4 shrink-0" />} text={t('nav.starred', '收藏')} to="/projects" search={{ view: 'starred' }} />
        <Row on={isProjects && view === 'mine'} icon={<User className="size-4 shrink-0" />} text={t('nav.mine', '我创建的')} to="/projects" search={{ view: 'mine' }} />

        <Fold show={open && projects.length > 0}>
          <div className="pt-5">
            <p className="eyebrow px-2.5 mb-1.5">{t('nav.recent', '最近')}</p>
            {projects.slice(0, 6).map((p) => (
              <Link key={p.id} to="/projects/$projectId" params={{ projectId: p.id }}
                className="block px-2.5 py-1.5 rounded-md text-[13px] text-fg-mid hover:text-fg hover:bg-panel-2/70 truncate whitespace-nowrap transition-colors">
                {p.name || '未命名项目'}
              </Link>
            ))}
          </div>
        </Fold>
      </div>

      <div className="mt-auto p-2 space-y-2">
        <Fold show={open}>
          <div className="flex items-center justify-between px-1">
            <span className="text-[10.5px] uppercase tracking-[.12em] text-fg-dim">{planName}</span>
            <LocaleToggle />
          </div>
        </Fold>
        <Fold show={open}>
          <div className="rounded-xl border border-edge bg-panel px-3.5 py-3 whitespace-nowrap">
            {credits ? <CreditMeter credits={credits} t={t} /> : (
              <div className="flex items-center gap-2">
                <span className="size-7 rounded-md bg-panel-2 text-fg grid place-items-center shrink-0"><Sparkles className="size-4" /></span>
                <div className="min-w-0"><p className="text-[13px] font-medium leading-tight">{planName}</p><p className="text-[11.5px] text-fg-dim">{used}/{limit} {t('nav.projectsUnit', '个项目')}</p></div>
              </div>
            )}
            {canUpgrade
              ? <Link to="/pricing" className="mt-3 w-full inline-flex items-center justify-center h-8 rounded-lg bg-fg text-ink text-[12.5px] font-medium hover:opacity-90 transition-opacity">{t('nav.upgradePlan', '升级套餐')}</Link>
              : <Link to="/settings" className="mt-3 w-full inline-flex items-center justify-center h-8 rounded-lg border border-edge text-fg-mid hover:text-fg text-[12.5px]">{t('nav.usage', '用量明细')}</Link>}
          </div>
        </Fold>
        <Fold show={!open}>
          <Tooltip>
            <TooltipTrigger render={<Link to={canUpgrade ? '/pricing' : '/settings'} className="h-9 w-10 grid place-items-center rounded-lg text-fg-mid hover:text-fg hover:bg-panel-2 cursor-pointer" />}><Sparkles className="size-4" /></TooltipTrigger>
            <TooltipContent side="right">{credits ? `${credits.left} credits` : canUpgrade ? t('nav.upgradePlan', '升级套餐') : t('nav.usage', '用量明细')}</TooltipContent>
          </Tooltip>
        </Fold>
        {/* account: at the foot, where a person looks for themselves rather than at the top of a nav */}
      <div className="px-2 pb-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<button className={`w-full h-11 flex items-center gap-2.5 pl-2 pr-2 rounded-lg transition-colors cursor-pointer text-left overflow-hidden whitespace-nowrap ${open ? 'border border-edge bg-panel hover:border-edge-strong' : 'hover:bg-panel-2'}`} />}>
            <span className="size-6 rounded-md bg-fg text-ink grid place-items-center text-[11px] font-semibold shrink-0">{initial}</span>
            <span className={`flex-1 min-w-0 ${fade}`}>
              <span className="block text-[13px] font-medium truncate leading-tight">{user.name || user.email} 的 Lovbase</span>
              <span className="block text-[11px] text-fg-dim leading-tight">{planName} · {used}/{limit} 个项目</span>
            </span>
            <ChevronsUpDown className={`size-4 text-fg-dim shrink-0 ${fade}`} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-center gap-3 py-2">
                <span className="size-9 rounded-lg bg-fg text-ink grid place-items-center text-[14px] font-semibold">{initial}</span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium truncate">{user.name || user.email} 的 Lovbase</span>
                  <span className="block text-[11.5px] text-fg-dim font-normal">{planName} Plan · 1 member</span>
                </span>
              </DropdownMenuLabel>
              <div className="px-2 py-2">
                <div className="flex items-center justify-between text-[12px] mb-1.5"><span className="font-medium">项目额度</span><span className="text-fg-dim">{used} / {limit}</span></div>
                <div className="h-1.5 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-fg rounded-full" style={{ width: `${Math.min(100, (used / Math.max(1, limit)) * 100)}%` }} /></div>
              </div>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link to="/settings" />}><User className="size-4" /> 账户</DropdownMenuItem>
            {user.isAdmin && <DropdownMenuItem render={<Link to="/admin" />}><ShieldCheck className="size-4" /> {t('nav.admin', '管理后台')}</DropdownMenuItem>}
            {canUpgrade && (
              <DropdownMenuItem render={<Link to="/pricing" />}>
                <Zap className="size-4" /> 升级套餐
                {/* explicit colours: the item's highlighted state recolours descendants */}
                <span className="ml-auto text-[11px] px-1.5 py-px rounded" style={{ background: 'var(--t-fg)', color: 'var(--t-ink)' }}>Upgrade</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => { resetIdentity(); void signOut().then(() => { location.href = '/login' }) }}><LogOut className="size-4" /> {t('nav.signout', '退出登录')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      </div>
    </aside>
    </>
  )
}

function FolderInput({ value, onChange, onDone, onCancel }: { value: string; onChange: (v: string) => void; onDone: () => void; onCancel: () => void }) {
  return (
    <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder="文件夹名"
      onBlur={onDone} onKeyDown={(e) => { if (e.key === 'Enter') onDone(); if (e.key === 'Escape') onCancel() }}
      className="w-full px-2 py-1.5 text-[13px] bg-panel border border-edge-strong rounded-md focus:outline-none" />
  )
}


/**
 * Credits are the unit people are actually spending, so the number left is the headline and the
 * bar is supporting detail. It warms to the warning colour once a fifth is left, which is the
 * point at which someone needs to decide whether to upgrade.
 */
function CreditMeter({ credits, t }: {
  credits: { left: number; included: number; bonus: number; used: number; periodEnd?: string }
  t: (k: string, f: string) => string
}) {
  const total = Math.max(1, credits.included + credits.bonus)
  const pct = Math.min(100, Math.round((credits.used / total) * 100))
  const low = credits.left <= total * 0.2
  const resets = credits.periodEnd ? new Date(credits.periodEnd).toISOString().slice(5, 10).replace('-', '/') : ''
  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10.5px] uppercase tracking-[.12em] text-fg-dim">Credits</span>
        {resets && <span className="text-[10.5px] text-fg-dim tabular-nums">{resets} {t('nav.resets', '重置')}</span>}
      </div>
      <div className="flex items-baseline gap-1.5 mt-1">
        <span className={`text-[22px] font-semibold tabular-nums leading-none ${low ? 'text-warn' : 'text-fg'}`}>{credits.left}</span>
        <span className="text-[11.5px] text-fg-dim tabular-nums">/ {total}</span>
      </div>
      <div className="h-1 mt-2.5 rounded-full bg-panel-2 overflow-hidden">
        <div className={`h-full rounded-full transition-[width] duration-500 ${low ? 'bg-warn' : 'bg-fg'}`} style={{ width: `${pct}%` }} />
      </div>
    </>
  )
}
