import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, mergeAttributes, Node } from '@tiptap/react'
import { Document } from '@tiptap/extension-document'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Text } from '@tiptap/extension-text'
import { HardBreak } from '@tiptap/extension-hard-break'
import { UndoRedo } from '@tiptap/extensions'
import Placeholder from '@tiptap/extension-placeholder'
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion'
import { createPortal } from 'react-dom'
import { PluginKey } from '@tiptap/pm/state'
import { FileCode2 } from 'lucide-react'
import { usePromptInputController } from './ai-elements/prompt-input'

// ── Prompt editor: plain text + inline file-reference chips. ──
// Serialises to text with `@[path]` tokens; the server expands those into file contents.
// Chips arrive two ways: typing `@` (suggestion list) or a `lovbase:reference` window event
// dispatched by the code pane's "在对话中引用". `lovbase:insert` and `lovbase:replace` fill the draft.

export const REF_RE = /@\[([^\]]+)\]/g

const FileRef = Node.create({
  name: 'fileRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() { return { path: { default: '' } } },
  parseHTML() { return [{ tag: 'span[data-file-ref]' }] },
  renderHTML({ node, HTMLAttributes }) {
    const path = String(node.attrs.path)
    const name = path.split('/').pop() ?? path
    return ['span', mergeAttributes(HTMLAttributes, { 'data-file-ref': path, class: 'file-chip', title: path }), name]
  },
  renderText({ node }) { return `@[${node.attrs.path}]` },
})

type Item = { path: string }

function SuggestList({ items, command, selected }: { items: Item[]; command: (i: Item) => void; selected: number }) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' }) }, [selected, items])
  if (items.length === 0) return <div className="px-3 py-2 text-[12px] text-fg-dim">没有匹配的文件</div>
  return (
    <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
      {items.map((it, i) => (
        <button key={it.path} onMouseDown={(e) => { e.preventDefault(); command(it) }}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] ${i === selected ? 'bg-panel-2 text-fg' : 'text-fg-mid'}`}>
          <FileCode2 className="size-3.5 shrink-0 text-fg-dim" />
          <span className="truncate">{it.path.split('/').pop()}</span>
          <span className="ml-auto text-[11px] text-fg-dim truncate max-w-[50%]">{it.path}</span>
        </button>
      ))}
    </div>
  )
}

export function PromptEditor({ placeholder, listFiles, className }: {
  placeholder: string
  listFiles: () => Promise<string[]>
  className?: string
}) {
  const { textInput } = usePromptInputController()
  const filesRef = useRef<string[] | null>(null)
  const [popup, setPopup] = useState<{ items: Item[]; rect: DOMRect | null; command: (i: Item) => void; selected: number } | null>(null)
  const popupRef = useRef(popup); popupRef.current = popup

  const editor = useEditor({
    extensions: [
      Document, Paragraph, Text, HardBreak, UndoRedo,
      Placeholder.configure({ placeholder }),
      FileRef,
    ],
    editorProps: {
      attributes: { class: `prompt-editor ${className ?? ''}` },
      handleKeyDown(_view, e) {
        const p = popupRef.current
        if (p) {
          if (e.key === 'ArrowDown') { setPopup({ ...p, selected: (p.selected + 1) % Math.max(1, p.items.length) }); return true }
          if (e.key === 'ArrowUp') { setPopup({ ...p, selected: (p.selected - 1 + p.items.length) % Math.max(1, p.items.length) }); return true }
          if (e.key === 'Enter' || e.key === 'Tab') { if (p.items[p.selected]) p.command(p.items[p.selected]); return true }
          if (e.key === 'Escape') { setPopup(null); return true }
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          ;(e.target as HTMLElement).closest('form')?.requestSubmit()
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor }) => textInput.setInput(editor.getText({ blockSeparator: '\n' })),
    immediatelyRender: false,
  })

  // `@` suggestion plugin, registered once the editor exists (needs the editor instance).
  useEffect(() => {
    if (!editor) return
    const plugin = Suggestion<Item>({
      editor,
      char: '@',
      pluginKey: new PluginKey('fileSuggestion'),
      allowSpaces: false,
      items: async ({ query }) => {
        filesRef.current ??= await listFiles().catch(() => [])
        const q = query.toLowerCase()
        const rank = (p: string) => (p.startsWith('src/pages') ? 0 : p.startsWith('src/') && !p.startsWith('src/components/ui') ? 1 : p.startsWith('src/') ? 2 : p.startsWith('.') ? 4 : 3)
        return filesRef.current.filter((p) => p.toLowerCase().includes(q)).toSorted((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 12).map((path) => ({ path }))
      },
      command: ({ editor, range, props }) => {
        editor.chain().focus().insertContentAt(range, [{ type: 'fileRef', attrs: { path: props.path } }, { type: 'text', text: ' ' }]).run()
        setPopup(null)
      },
      render: () => ({
        onStart: (p: SuggestionProps<Item>) => setPopup({ items: p.items, rect: p.clientRect?.() ?? null, command: p.command, selected: 0 }),
        onUpdate: (p: SuggestionProps<Item>) => setPopup((cur) => ({ items: p.items, rect: p.clientRect?.() ?? null, command: p.command, selected: Math.min(cur?.selected ?? 0, Math.max(0, p.items.length - 1)) })),
        onExit: () => setPopup(null),
        onKeyDown: () => false,
      }),
    })
    editor.registerPlugin(plugin)
    return () => { editor.unregisterPlugin('fileSuggestion' as any) }
  }, [editor])

  // Cleared by PromptInput after a successful submit → empty the editor too.
  useEffect(() => { if (editor && textInput.value === '' && !editor.isEmpty) editor.commands.clearContent() }, [textInput.value, editor])

  // "在对话中引用" from the code pane.
  useEffect(() => {
    if (!editor) return
    const onRef = (e: Event) => {
      const path = (e as CustomEvent<{ path: string }>).detail?.path
      if (!path) return
      editor.chain().focus('end').insertContent([{ type: 'fileRef', attrs: { path } }, { type: 'text', text: ' ' }]).run()
    }
    // `lovbase:insert` puts plain text in (skill picker); `lovbase:replace` swaps the whole
    // draft (editing an earlier message).
    const onInsert = (e: Event) => {
      const text = (e as CustomEvent).detail?.text
      if (typeof text === 'string') editor.chain().focus('end').insertContent(text + ' ').run()
    }
    const onReplace = (e: Event) => {
      const text = (e as CustomEvent).detail?.text
      if (typeof text === 'string') editor.chain().focus('end').setContent(text).focus('end').run()
    }
    window.addEventListener('lovbase:reference', onRef)
    window.addEventListener('lovbase:insert', onInsert)
    window.addEventListener('lovbase:replace', onReplace)
    return () => {
      window.removeEventListener('lovbase:reference', onRef)
      window.removeEventListener('lovbase:insert', onInsert)
      window.removeEventListener('lovbase:replace', onReplace)
    }
  }, [editor])

  return (
    <div className="relative w-full px-3 pt-2.5 pb-1">
      <EditorContent editor={editor} />
      {popup && popup.rect && typeof document !== 'undefined' && createPortal(
        <div className="fixed z-50 w-80 bg-panel border border-edge rounded-lg shadow-xl overflow-hidden"
          style={{ left: Math.min(popup.rect.left, window.innerWidth - 336), bottom: window.innerHeight - popup.rect.top + 8 }}>
          <p className="px-3 pt-2 text-[10.5px] text-fg-dim">引用文件 · ↑↓ 选择,Enter 确认</p>
          <SuggestList items={popup.items} command={popup.command} selected={popup.selected} />
        </div>,
        document.body,
      )}
    </div>
  )
}

/** Turn `@[path]` tokens into a readable form for models that cannot read the sandbox themselves. */
export const refsIn = (text: string) => [...text.matchAll(REF_RE)].map((m) => m[1])
