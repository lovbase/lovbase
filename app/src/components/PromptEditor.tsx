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
import { usePromptInputController, usePromptInputAttachments } from './ai-elements/prompt-input'
import { useT } from '../lib/i18n'

// ── Prompt editor: plain text + inline file-reference chips. ──
// Serialises to text with `@[path]` tokens; the server expands those into file contents.
// Chips arrive two ways: typing `@` (suggestion list) or a `lovbase:reference` window event
// dispatched by the code pane's "Reference in chat". `lovbase:insert` and `lovbase:replace` fill the draft.

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

/**
 * An attached file, as an inline chip in the text.
 *
 * Attachments used to live in a strip above the editor, which pushed the composer down by a row of
 * thumbnails the moment a file landed. Inline they behave the way a person expects a thing they
 * dropped into a sentence to behave: it sits where the cursor was, backspace deletes it, and the
 * file goes with it. The node carries no text — the bytes travel through the attachment context,
 * not the prompt — so `renderText` is empty on purpose.
 */
const AttachRef = Node.create({
  name: 'attachRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    const hidden = (parse: (el: HTMLElement) => string) => ({ default: '', parseHTML: parse, renderHTML: () => ({}) })
    return {
      aid: hidden((el) => el.getAttribute('data-attach-ref') ?? ''),
      filename: hidden((el) => el.getAttribute('title') ?? ''),
      mediaType: hidden(() => ''),
      url: hidden(() => ''),
    }
  },
  parseHTML() { return [{ tag: 'span[data-attach-ref]' }] },
  renderHTML({ node, HTMLAttributes }) {
    const { aid, filename, mediaType, url } = node.attrs as Record<string, string>
    const name = filename || 'Attachment'
    const attrs = mergeAttributes(HTMLAttributes, { 'data-attach-ref': aid, class: 'file-chip attach-chip', title: name })
    return mediaType?.startsWith('image/') && url
      ? ['span', attrs, ['img', { src: url, alt: '', class: 'attach-thumb' }], name]
      : ['span', attrs, name]
  },
  renderText() { return '' },
})

type Item = { path: string }

function SuggestList({ items, command, selected }: { items: Item[]; command: (i: Item) => void; selected: number }) {
  const t = useT()
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' }) }, [selected, items])
  if (items.length === 0) return <div className="px-3 py-2 text-[12px] text-fg-dim">{t('chat.ref.noMatch', 'No matching files')}</div>
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

export function PromptEditor({ placeholder, listFiles, className, onActivity }: {
  placeholder: string
  listFiles: () => Promise<string[]>
  className?: string
  onActivity?: () => void
}) {
  const t = useT()
  const { textInput } = usePromptInputController()
  // Throws when the provider is momentarily missing (HMR remounts); the editor still has to work.
  let attachments: ReturnType<typeof usePromptInputAttachments> | null = null
  try { attachments = usePromptInputAttachments() } catch { attachments = null }
  // `useEditor` captures its options once; the paste handler below has to reach the live context.
  const attachRef = useRef(attachments); attachRef.current = attachments
  const [preview, setPreview] = useState<{ url: string; filename?: string; mediaType?: string } | null>(null)
  const filesRef = useRef<string[] | null>(null)
  const [popup, setPopup] = useState<{ items: Item[]; rect: DOMRect | null; command: (i: Item) => void; selected: number } | null>(null)
  const popupRef = useRef(popup); popupRef.current = popup

  const editor = useEditor({
    extensions: [
      Document, Paragraph, Text, HardBreak, UndoRedo,
      Placeholder.configure({ placeholder }),
      FileRef, AttachRef,
    ],
    editorProps: {
      attributes: { class: `prompt-editor ${className ?? ''}` },
      // PromptInput's own paste-to-attach lives on the textarea this editor replaced, so without
      // this, pasting a screenshot into the composer did nothing at all — the most natural way to
      // attach an image was the one way that was not wired up.
      handlePaste(_view, e) {
        const files = [...(e.clipboardData?.items ?? [])]
          .filter((it) => it.kind === 'file')
          .map((it) => it.getAsFile())
          .filter((f): f is File => !!f)
        if (files.length === 0) return false
        e.preventDefault()
        attachRef.current?.add(files)
        return true // the chip is inserted by the reconcile effect, from the id the context assigns
      },
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
    onUpdate: ({ editor }) => {
      textInput.setInput(editor.getText({ blockSeparator: '\n' }))
      onActivity?.()
    },
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

  // ── Attachments ↔ the document ──
  //
  // Two stores have to agree: the attachment context holds the bytes, the document holds the chip.
  // Rather than try to keep them in lockstep on every keystroke, reconcile by id in one direction
  // each: a file with no chip gets one, and a chip the user deleted takes its file with it.
  const aidsInDoc = () => {
    const ids: string[] = []
    editor?.state.doc.descendants((n) => { if (n.type.name === 'attachRef') ids.push(String(n.attrs.aid)) })
    return ids
  }

  useEffect(() => {
    if (!editor || !attachments) return
    const have = new Set(aidsInDoc())
    const added = attachments.files.filter((f) => !have.has(f.id))
    if (added.length === 0) return
    editor.chain().focus().insertContent(
      added.flatMap((f) => [
        { type: 'attachRef', attrs: { aid: f.id, filename: f.filename ?? t('chat.attachment', 'Attachment'), mediaType: f.mediaType ?? '', url: f.url ?? '' } },
        { type: 'text', text: ' ' },
      ]),
    ).run()
  }, [editor, attachments?.files])

  useEffect(() => {
    if (!editor || !attachments) return
    const onTx = () => {
      const have = new Set(aidsInDoc())
      for (const f of attachments.files) if (!have.has(f.id)) attachments.remove(f.id)
    }
    editor.on('update', onTx)
    return () => { editor.off('update', onTx) }
  }, [editor, attachments])

  // Clicking a chip opens the file; the editor swallows the event otherwise.
  useEffect(() => {
    if (!editor) return
    const el = editor.view.dom
    const onClick = (e: MouseEvent) => {
      const chip = (e.target as HTMLElement | null)?.closest?.('[data-attach-ref]') as HTMLElement | null
      if (!chip) return
      const f = attachments?.files.find((x) => x.id === chip.getAttribute('data-attach-ref'))
      if (f?.url) { e.preventDefault(); setPreview({ url: f.url, filename: f.filename, mediaType: f.mediaType }) }
    }
    el.addEventListener('click', onClick)
    return () => { el.removeEventListener('click', onClick) }
  }, [editor, attachments])

  // Cleared by PromptInput after a successful submit → empty the editor too.
  useEffect(() => { if (editor && textInput.value === '' && !editor.isEmpty) editor.commands.clearContent() }, [textInput.value, editor])

  // "Reference in chat" from the code pane.
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
      {preview && typeof document !== 'undefined' && createPortal(
        <div onClick={() => setPreview(null)} className="fixed inset-0 z-[80] grid place-items-center bg-black/70 backdrop-blur-[2px] p-8">
          <div onClick={(e) => e.stopPropagation()} className="max-w-[min(48rem,90vw)] max-h-[85vh] flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[12px] text-fg-mid">
              <span className="truncate">{preview.filename}</span>
              <a href={preview.url} target="_blank" rel="noreferrer" className="ml-auto shrink-0 hover:text-fg">{t('preview.open', 'Open in a new tab')}</a>
              <button onClick={() => setPreview(null)} className="shrink-0 hover:text-fg cursor-pointer">{t('palette.close', 'Close')}</button>
            </div>
            {preview.mediaType?.startsWith('image/')
              ? <img src={preview.url} alt={preview.filename} className="max-h-[78vh] rounded-lg object-contain" />
              : <p className="text-[12.5px] text-fg-dim">{t('chat.attach.noPreview', 'This type cannot be previewed here; open it with the link above.')}</p>}
          </div>
        </div>,
        document.body,
      )}
      {popup && popup.rect && typeof document !== 'undefined' && createPortal(
        <div className="fixed z-50 w-80 bg-panel border border-edge rounded-lg shadow-xl overflow-hidden"
          style={{ left: Math.min(popup.rect.left, window.innerWidth - 336), bottom: window.innerHeight - popup.rect.top + 8 }}>
          <p className="px-3 pt-2 text-[10.5px] text-fg-dim">{t('chat.ref.hint', 'Reference a file · ↑↓ to choose, Enter to confirm')}</p>
          <SuggestList items={popup.items} command={popup.command} selected={popup.selected} />
        </div>,
        document.body,
      )}
    </div>
  )
}

/** Turn `@[path]` tokens into a readable form for models that cannot read the sandbox themselves. */
export const refsIn = (text: string) => [...text.matchAll(REF_RE)].map((m) => m[1])
