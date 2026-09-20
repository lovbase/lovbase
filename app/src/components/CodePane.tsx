import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { json } from '@codemirror/lang-json'
import { sql } from '@codemirror/lang-sql'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'
import { Braces, FileCode2, FileJson2, FileText, Palette, Database, Settings2 } from 'lucide-react'
import type { IR } from '@lovbase/core/ir'
import { appFiles, appReadFile, appWriteFile } from '../functions'
import { FileTree, FileTreeActions, FileTreeFile, FileTreeFolder } from './ai-elements/file-tree'
import { ResizeHandle, useStoredResizable } from '../lib/use-resizable'
import { useT } from '../lib/i18n'
import { MoreHorizontal } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

/** Follow the app's dark class so the editor theme matches. */
function useDark() {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const el = document.documentElement
    const read = () => setDark(el.classList.contains('dark'))
    read()
    const mo = new MutationObserver(read); mo.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])
  return dark
}

function iconFor(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  const cls = 'size-4'
  if (ext === 'tsx' || ext === 'jsx') return <FileCode2 className={`${cls} text-sky-500`} />
  if (ext === 'ts' || ext === 'js' || ext === 'mjs') return <Braces className={`${cls} text-amber-500`} />
  if (ext === 'json' || ext === 'jsonc') return <FileJson2 className={`${cls} text-yellow-600`} />
  if (ext === 'css') return <Palette className={`${cls} text-violet-500`} />
  if (ext === 'sql') return <Database className={`${cls} text-db`} />
  if (ext === 'html') return <FileCode2 className={`${cls} text-orange-500`} />
  if (name.startsWith('.') || ext === 'lock') return <Settings2 className={`${cls} text-fg-dim`} />
  return <FileText className={`${cls} text-fg-dim`} />
}

/** File tree + editor over the sandbox project, plus two virtual read-only files derived from the IR. */
export function CodePane({ projectId, appId, ir, ddl, onSaved, openFile }: { projectId: string; appId: string; ir: IR; ddl: string; onSaved?: () => void; openFile?: { file?: string; n: number } | null }) {
  const t = useT()
  const listFn = useServerFn(appFiles)
  const readFn = useServerFn(appReadFile)
  const writeFn = useServerFn(appWriteFile)
  const [files, setFiles] = useState<string[] | null>(null)
  const [err, setErr] = useState('')
  const [active, setActive] = useState('schema.sql')
  const [content, setContent] = useState(ddl)
  const [saved, setSaved] = useState(ddl)
  const [saving, setSaving] = useState(false)
  const cache = useRef(new Map<string, string>())

  const virtual: Record<string, string> = useMemo(() => ({ 'schema.sql': ddl, 'ir.json': JSON.stringify(ir, null, 2) }), [ddl, ir])
  const readOnly = active in virtual
  const dirty = !readOnly && content !== saved

  useEffect(() => {
    listFn({ data: { projectId, appId } }).then((r) => setFiles(r.files.map((f) => f.path))).catch((e) => setErr(e.message))
  }, [projectId, appId])

  const open = useCallback(async (path: string) => {
    if (dirty && !confirm('当前文件有未保存的修改,放弃?')) return
    setActive(path); setErr('')
    if (path in virtual) { setContent(virtual[path]); setSaved(virtual[path]); return }
    const hit = cache.current.get(path)
    if (hit != null) { setContent(hit); setSaved(hit); return }
    try {
      const r = await readFn({ data: { projectId, appId, path } })
      cache.current.set(path, r.content); setContent(r.content); setSaved(r.content)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [dirty, virtual, projectId])
  useEffect(() => { if (openFile?.file && files?.includes(openFile.file)) open(openFile.file) }, [openFile?.n, files])

  async function save() {
    if (readOnly || !dirty || saving) return
    setSaving(true); setErr('')
    try {
      await writeFn({ data: { projectId, appId, path: active, content } })
      cache.current.set(active, content); setSaved(content); onSaved?.()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save() } }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  })

  const lang = useMemo(() => {
    const ext = active.split('.').pop()
    if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return [javascript({ jsx: true, typescript: true })]
    if (ext === 'css') return [css()]
    if (ext === 'html') return [html()]
    if (ext === 'json') return [json()]
    if (ext === 'sql') return [sql()]
    return []
  }, [active])

  const tree = useMemo(() => buildTree(files ?? []), [files])
  const dark = useDark()
  const side = useStoredResizable('code-side', 240, 180, 480)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['src', 'src/pages', 'src/lib']))

  // Two panels floating on the page rather than one edge-to-edge split. The gap and the rounded
  // surfaces are what separate "a file list next to a textarea" from something that reads as a
  // workspace: each panel owns a header, and the code panel's header carries the path and size
  // the way an editor does.
  return (
    <div className="h-full min-w-0 flex gap-1 p-2 bg-ink text-fg">
      <aside className="shrink-0 flex flex-col rounded-xl border border-edge bg-panel overflow-hidden" style={{ width: side.width }}>
        <div className="h-10 shrink-0 flex items-center px-3 border-b border-edge">
          <span className="text-[13px] font-medium">{t('code.files', '文件')}</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto py-2 text-[12.5px]">
          <p className="font-mono text-[10px] uppercase tracking-widest text-fg-dim px-3 pt-1 pb-1">schema</p>
          <FileTree selectedPath={active} onSelect={open} className="border-0 bg-transparent">
            {Object.keys(virtual).map((p) => <FileTreeFile key={p} path={p} name={p} icon={iconFor(p)} />)}
          </FileTree>
          <p className="font-mono text-[10px] uppercase tracking-widest text-fg-dim px-3 pt-4 pb-1">app</p>
          {files === null && !err && <p className="px-3 text-fg-dim">正在读取…</p>}
          {files?.length === 0 && <p className="px-3 text-fg-dim">还没有生成代码,先描述你想要的应用</p>}
          <FileTree selectedPath={active} onSelect={open} expanded={expanded} onExpandedChange={setExpanded} className="border-0 bg-transparent">
            {tree.map((n) => <TreeNode key={n.path} node={n} />)}
          </FileTree>
        </div>
      </aside>
      <ResizeHandle {...side.handleProps} />
      <div className="flex-1 min-w-0 flex flex-col rounded-xl border border-edge bg-panel overflow-hidden">
        <div className="h-10 shrink-0 flex items-center gap-3 px-3 border-b border-edge">
          {/* The directories in a muted tone and the filename in full: the path reads as a location
              rather than one long string, which is the whole job of a breadcrumb. */}
          <span className="font-mono text-[12px] min-w-0 truncate">
            <span className="text-fg-dim">{active.includes('/') ? active.slice(0, active.lastIndexOf('/') + 1) : ''}</span>
            <span className="text-fg">{active.slice(active.lastIndexOf('/') + 1)}</span>
          </span>
          {readOnly ? <span className="text-[11.5px] text-fg-dim shrink-0">只读 · 由 IR 生成</span>
            : dirty ? <span className="text-[11.5px] text-accent-soft shrink-0">未保存</span>
            : <span className="text-[11.5px] text-fg-dim shrink-0">已保存</span>}
          <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-dim tabular-nums">{sizeOf(content)}</span>
          {err && <span className="shrink-0 text-[11.5px] text-warn max-w-[14rem] truncate">{err}</span>}
          {!readOnly && (
            <button onClick={save} disabled={!dirty || saving}
              className="shrink-0 px-2.5 py-1 rounded-md bg-accent text-on-accent text-[11.5px] hover:bg-accent-soft disabled:opacity-40 transition-colors cursor-pointer">
              {saving ? '保存中…' : '保存 ⌘S'}
            </button>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          <CodeMirror value={content} onChange={setContent} readOnly={readOnly} height="100%" className="h-full text-[13px]"
            theme={dark ? githubDark : githubLight}
            extensions={[...lang, EditorView.lineWrapping]} basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly }} />
        </div>
      </div>
    </div>
  )
}

/** Byte size of what is on screen, the way an editor's status bar reports it. */
function sizeOf(text: string): string {
  const b = new TextEncoder().encode(text).length
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

type TreeNodeT = { name: string; path: string; children?: TreeNodeT[] }

/** Nested tree from flat paths; folders first, then files, both alphabetical. */
function buildTree(paths: string[]): TreeNodeT[] {
  const root: TreeNodeT = { name: '', path: '', children: [] }
  for (const p of paths) {
    const parts = p.split('/')
    let cur = root
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/')
      const isFile = i === parts.length - 1
      let next = cur.children!.find((c) => c.path === path)
      if (!next) { next = isFile ? { name: part, path } : { name: part, path, children: [] }; cur.children!.push(next) }
      cur = next
    })
  }
  const sort = (nodes: TreeNodeT[]) => {
    nodes.sort((a, b) => (!!b.children === !!a.children ? a.name.localeCompare(b.name) : a.children ? -1 : 1))
    for (const n of nodes) if (n.children) sort(n.children)
  }
  sort(root.children!)
  return root.children!
}

function TreeNode({ node }: { node: TreeNodeT }) {
  if (node.children)
    return (
      <FileTreeFolder path={node.path} name={node.name}>
        {node.children.map((c) => <TreeNode key={c.path} node={c} />)}
      </FileTreeFolder>
    )
  return (
    <FileTreeFile path={node.path} name={node.name} icon={iconFor(node.name)}>
      <span className="size-4 shrink-0" />
      <span className="flex items-center gap-2 min-w-0 flex-1">
        {iconFor(node.name)}<span className="truncate">{node.name}</span>
      </span>
      <FileTreeActions className="opacity-0 group-hover:opacity-100 data-[popup-open]:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger render={<button className="size-6 grid place-items-center rounded text-fg-dim hover:text-fg hover:bg-panel-2 cursor-pointer" />}><MoreHorizontal className="size-3.5" /></DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => window.dispatchEvent(new CustomEvent('lovbase:reference', { detail: { path: node.path } }))}>在对话中引用</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </FileTreeActions>
    </FileTreeFile>
  )
}
