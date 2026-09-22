import { useEffect, useRef, useState } from 'react'
import type { ChatStatus, FileUIPart } from 'ai'
import { Check, ChevronDown } from 'lucide-react'
import { useI18n, useT } from '../lib/i18n'
import { PromptInput, PromptInputBody, PromptInputProvider, PromptInputSubmit, usePromptInputAttachments } from './ai-elements/prompt-input'
import { PromptEditor } from './PromptEditor'
import { PlusMenu } from './PlusMenu'
import { AnchoredPopup } from './AnchoredPopup'

export type TierOption = { tier: string; label: { zh: string; en: string }; model: string; isDefault: boolean }
export type ComposerMessage = { text: string; files: FileUIPart[] }

/**
 * The one composer. The home page and the project chat draw the same box with the same controls,
 * so what a person learns on one page is true on the other; only what happens on submit differs.
 */
export function Composer({ onSubmit, status = 'ready', onStop, tiers, tier, onTier, listFiles, placeholder, hint, size = 'sm', onFocus }: {
  onSubmit: (msg: ComposerMessage) => void | Promise<void>
  status?: ChatStatus
  onStop?: () => void
  tiers: TierOption[]; tier: string; onTier: (t: string) => void
  listFiles: () => Promise<string[]>
  placeholder: string
  hint?: string
  /** `lg` is the home page: one box alone on a page wants more air than one under a transcript. */
  size?: 'sm' | 'lg'
  /** The editor took focus: a message is probably coming. */
  onFocus?: () => void
}) {
  const lg = size === 'lg'
  return (
    <div onFocusCapture={onFocus}>
      <PromptInputProvider>
        <PromptInput
          onSubmit={async (msg) => {
            if (!msg.text.trim() && msg.files.length === 0) return
            await onSubmit({ text: msg.text, files: msg.files })
          }}
          globalDrop multiple maxFiles={6} maxFileSize={8 * 1024 * 1024}
          accept="image/*,.csv,.tsv,.txt,.md,.json,.xml,.yaml,.yml,text/*,application/json"
          className={`bg-panel border-edge focus-within:border-edge-strong transition-colors ${lg
            ? 'rounded-[1.5rem] p-2 shadow-[0_1px_2px_rgb(0_0_0/.03),0_24px_48px_-24px_rgb(0_0_0/.18)]'
            : 'rounded-[1.375rem] shadow-[0_1px_2px_rgb(0_0_0/.03),0_12px_32px_-20px_rgb(0_0_0/.25)]'}`}
        >
          <div data-align="block-end" className="w-full flex flex-col">
            <PromptInputBody>
              <PromptEditor listFiles={listFiles} placeholder={placeholder} className={lg ? 'min-h-[4.5rem] text-[16px]' : undefined} />
            </PromptInputBody>
            <div className="flex items-center gap-1 px-2 pb-2">
              <AttachButton size={size} />
              <TierPicker options={tiers} value={tier} onChange={onTier} size={size} />
              <div className="flex-1" />
              <PromptInputSubmit status={status} className={lg ? 'rounded-full size-10' : 'rounded-full'} onStop={onStop} />
            </div>
          </div>
        </PromptInput>
      </PromptInputProvider>
      {hint && <p className="text-[10.5px] text-fg-dim mt-1.5 px-1 truncate">{hint}</p>}
    </div>
  )
}

/** The "+" menu, with "attach" wired to this composer's file dialog. */
function AttachButton({ size }: { size: 'sm' | 'lg' }) {
  const ctx = usePromptInputAttachments()
  return <PlusMenu size={size} onAttach={() => ctx.openFileDialog()} />
}

/**
 * The chosen model tier, remembered across pages and reloads. Both composers read and write the
 * same key, so a tier picked on the home page is the tier the project chat opens with.
 */
export function useTier(tiers: TierOption[]) {
  const [tier, setTier] = useState<string>(() => tiers.find((t) => t.isDefault)?.tier ?? 'standard')
  useEffect(() => {
    try {
      const saved = localStorage.getItem('lovbase:tier')
      if (saved && tiers.some((t) => t.tier === saved)) setTier(saved)
    } catch { /* private mode */ }
  }, [tiers])
  const pick = (t: string) => { setTier(t); try { localStorage.setItem('lovbase:tier', t) } catch { /* private mode */ } }
  return [tier, pick] as const
}

function TierPicker({ options, value, onChange, size }: { options: TierOption[]; value: string; onChange: (t: string) => void; size: 'sm' | 'lg' }) {
  const { locale } = useI18n()
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  if (options.length < 2) return null
  const current = options.find((o) => o.tier === value) ?? options.find((o) => o.isDefault) ?? options[0]
  const name = (o: TierOption) => (locale === 'en' ? o.label.en : o.label.zh)
  return (
    <>
      <button ref={btn} type="button" onClick={() => setOpen((v) => !v)} title={`${name(current)} · ${current.model}`}
        className={`${size === 'lg' ? 'h-9 px-3.5 text-[13px]' : 'h-7 px-2.5 text-[12px]'} rounded-full border border-edge text-fg-dim hover:text-fg hover:bg-panel-2 cursor-pointer inline-flex items-center gap-1`}>
        {name(current)}
        <ChevronDown className="size-3 opacity-60" strokeWidth={2} />
      </button>
      <AnchoredPopup anchorRef={btn} open={open} onClose={() => setOpen(false)} width={224}>
        {options.map((o) => (
          <button type="button" key={o.tier}
            onMouseDown={(e) => { e.preventDefault(); onChange(o.tier); setOpen(false) }}
            className="w-full text-left px-3 py-2 hover:bg-panel-2 cursor-pointer flex items-center gap-2">
            <Check className={`size-3.5 shrink-0 ${o.tier === current.tier ? 'text-fg' : 'opacity-0'}`} strokeWidth={2} />
            <span className="text-[12.5px] text-fg flex-1">{name(o)}</span>
            <span className="font-mono text-[10.5px] text-fg-dim truncate max-w-24">{o.model}</span>
          </button>
        ))}
      </AnchoredPopup>
    </>
  )
}

/** Composer hint text; the same line under both boxes. */
export function useComposerHint() {
  const t = useT()
  return t('chat.hint', 'Enter 发送 · Shift+Enter 换行 · 拖入图片或 CSV')
}
