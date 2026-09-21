import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Home, LayoutGrid, Plus, ShieldCheck, Star, User } from 'lucide-react'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { newProject } from '../functions'
import { useDialogs } from './Dialogs'
import { MiniApp } from './MiniApp'

export type PaletteProject = { id: string; name: string; tables: string[]; entities: number; shared: boolean; starred: boolean; updated_at: string }

/** ⌘K: search projects and navigate. Left = results, right = preview of the highlighted project. */
export function CommandPalette({ open, onOpenChange, projects, isAdmin, ownerName }: {
  open: boolean; onOpenChange: (o: boolean) => void; projects: PaletteProject[]; isAdmin: boolean; ownerName: string
}) {
  const navigate = useNavigate()
  const create = useServerFn(newProject)
  const dialogs = useDialogs()
  const first = projects[0] ? `project:${projects[0].id}` : 'nav:home'
  const [value, setValue] = useState(first)
  useEffect(() => { if (open) setValue(first) }, [open, first])
  const highlighted = useMemo(() => projects.find((p) => `project:${p.id}` === value) ?? null, [value, projects])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); onOpenChange(!open) } }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [open])
  const go = (fn: () => void) => { onOpenChange(false); fn() }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="p-0 overflow-hidden sm:max-w-[56rem] w-[56rem] gap-0 bg-panel border-edge">
        <DialogTitle className="sr-only">搜索</DialogTitle>
        <Command value={value} onValueChange={setValue} className="bg-transparent" loop>
          <CommandInput placeholder="搜索项目、页面…" className="text-[15px] h-12" />
          <div className="flex h-[26rem]">
            <CommandList className="w-[52%] max-h-none border-r border-edge py-1">
              <CommandEmpty>没有匹配的结果</CommandEmpty>
              <CommandGroup heading="最近项目">
                {projects.slice(0, 8).map((p) => (
                  <CommandItem key={p.id} value={`project:${p.id}`} keywords={[p.name || '未命名项目', ...p.tables]}
                    onSelect={() => go(() => navigate({ to: '/projects/$projectId', params: { projectId: p.id } }))}>
                    <span className="size-4 grid place-items-center"><span className="size-2 rotate-45 border border-fg-mid rounded-[1px]" /></span>
                    <span className="truncate">{p.name || '未命名项目'}</span>
                    {p.starred && <Star className="size-3.5 ml-auto text-fg-dim" />}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="前往">
                <CommandItem value="nav:home" onSelect={() => go(() => navigate({ to: '/home' }))}><Home className="size-4" /> 首页</CommandItem>
                <CommandItem value="nav:projects" onSelect={() => go(() => navigate({ to: '/projects', search: {} }))}><LayoutGrid className="size-4" /> 全部项目</CommandItem>
                <CommandItem value="nav:new" onSelect={() => go(() => create().then(({ id }) => navigate({ to: '/projects/$projectId', params: { projectId: id } })).catch((e) => dialogs.alert({ title: '新建项目失败', description: e.message })))}><Plus className="size-4" /> 新建项目</CommandItem>
                <CommandItem value="nav:starred" onSelect={() => go(() => navigate({ to: '/projects', search: { view: 'starred' } }))}><Star className="size-4" /> 收藏</CommandItem>
                <CommandItem value="nav:account" onSelect={() => go(() => navigate({ to: '/settings' }))}><User className="size-4" /> 账户</CommandItem>
                {isAdmin && <CommandItem value="nav:admin" onSelect={() => go(() => navigate({ to: '/admin' }))}><ShieldCheck className="size-4" /> 管理后台</CommandItem>}
              </CommandGroup>
            </CommandList>
            <div className="flex-1 min-w-0 bg-ink/60 overflow-y-auto">
              {highlighted ? (
                <div>
                  <MiniApp name={highlighted.name || '未命名项目'} tables={highlighted.tables} className="h-44 rounded-none border-x-0 border-t-0" />
                  <div className="px-5 pb-5 space-y-4">
                    <p className="font-display text-[17px] font-semibold">{highlighted.name || '未命名项目'}</p>
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[12.5px]">
                      <div><dt className="text-fg-dim">所有者</dt><dd className="mt-0.5">{ownerName}</dd></div>
                      <div><dt className="text-fg-dim">状态</dt><dd className="mt-0.5">{highlighted.shared ? '已分享' : '私有'}</dd></div>
                      <div><dt className="text-fg-dim">数据表</dt><dd className="mt-0.5 tabular-nums">{highlighted.entities} 张</dd></div>
                      <div><dt className="text-fg-dim">最近修改</dt><dd className="mt-0.5 tabular-nums">{new Date(highlighted.updated_at).toISOString().slice(0, 10)}</dd></div>
                    </dl>
                    {highlighted.tables.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">{highlighted.tables.map((t) => <span key={t} className="px-2 py-0.5 rounded-md bg-panel border border-edge text-[11px] text-fg-mid">{t}</span>)}</div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="h-full grid place-items-center text-[13px] text-fg-dim">选中一个项目查看概览</div>
              )}
            </div>
          </div>
          <div className="flex items-center justify-end gap-4 px-4 h-10 border-t border-edge text-[12px] text-fg-dim">
            <span>打开 <kbd className="border border-edge rounded px-1 bg-panel">↵</kbd></span>
            <span>关闭 <kbd className="border border-edge rounded px-1 bg-panel">esc</kbd></span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
