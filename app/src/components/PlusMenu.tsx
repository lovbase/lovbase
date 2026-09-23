import { useRef, useState } from 'react'
import { Paperclip, Plug, Plus, Wand2 } from 'lucide-react'
import { useT } from '../lib/i18n'
import { AnchoredPopup } from './AnchoredPopup'

/**
 * The "+" on a composer. Today the only thing it can add is a file; the menu still lists the two
 * things it will add next, greyed, so the button's shape is settled before the features are.
 * The home page and the project chat share it so the two composers behave as one.
 */
export function PlusMenu({ onAttach, size = 'sm' }: { onAttach: () => void; size?: 'sm' | 'lg' }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const soon = t('chat.plus.soon', 'Soon')
  const row = 'w-full text-left px-3 py-2 flex items-center gap-2.5 text-[12.5px]'
  return (
    <>
      <button ref={btn} type="button" onClick={() => setOpen((v) => !v)}
        title={t('chat.attach', 'Image, CSV or text')}
        className={`${size === 'lg' ? 'size-9' : 'size-7'} grid place-items-center rounded-full border border-edge text-fg-dim hover:text-fg hover:bg-panel-2 cursor-pointer`}>
        <Plus className={`size-4 transition-transform ${open ? 'rotate-45' : ''}`} strokeWidth={1.75} />
      </button>
      <AnchoredPopup anchorRef={btn} open={open} onClose={() => setOpen(false)} width={200}>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); setOpen(false); onAttach() }}
          className={`${row} text-fg hover:bg-panel-2 cursor-pointer`}>
          <Paperclip className="size-4 shrink-0" strokeWidth={1.75} /> {t('chat.plus.attach', 'Add attachment')}
        </button>
        <div className={`${row} text-fg-dim cursor-default`} aria-disabled title={soon}>
          <Wand2 className="size-4 shrink-0" strokeWidth={1.75} /> {t('chat.plus.skills', 'Skills')}
          <span className="ml-auto text-[10.5px]">{soon}</span>
        </div>
        <div className={`${row} text-fg-dim cursor-default`} aria-disabled title={soon}>
          <Plug className="size-4 shrink-0" strokeWidth={1.75} /> {t('chat.plus.connectors', 'Connectors')}
          <span className="ml-auto text-[10.5px]">{soon}</span>
        </div>
      </AnchoredPopup>
    </>
  )
}
