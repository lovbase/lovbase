import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowUp } from 'lucide-react'
import { useT } from '../../lib/i18n'
import { track } from '../../lib/posthog'

/** Where the landing page leaves what someone typed; the home page picks it up after sign-up. */
export const LANDING_DRAFT = 'lovbase.landing-draft'

/**
 * The hero's call to action is the product's own first step: describe the app. Sending it goes
 * through sign-up and lands in the workspace with the text already in the box.
 */
export function HeroPrompt({ signedIn = false }: { signedIn?: boolean }) {
  const t = useT()
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const examples = [
    t('mk.example.crm', 'A small CRM for customers and follow-ups'),
    t('mk.example.stock', 'Track stock in and out of the warehouse'),
    t('mk.example.event', 'Sign-ups for a weekend event'),
    t('mk.example.money', 'A shared household budget'),
  ]

  function go() {
    const prompt = text.trim()
    try { if (prompt) sessionStorage.setItem(LANDING_DRAFT, prompt) } catch {}
    track('landing_prompt_submitted', { length: prompt.length })
    void navigate({ to: signedIn ? '/home' : '/signup' })
  }

  return (
    <div className="w-full max-w-[40rem] mx-auto text-left">
      <form onSubmit={(e) => { e.preventDefault(); go() }}
        className="rounded-[22px] border border-edge bg-panel shadow-[0_1px_2px_rgba(30,25,15,.04),0_12px_32px_-12px_rgba(30,25,15,.14)] focus-within:border-edge-strong transition-colors">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go() } }}
          rows={3}
          placeholder={t('mk.prompt.placeholder', 'Describe the app you want…')}
          aria-label={t('mk.prompt.placeholder', 'Describe the app you want…')}
          className="block w-full resize-none bg-transparent px-5 pt-4 text-[16px] leading-7 text-fg placeholder:text-fg-dim outline-none"
        />
        <div className="flex items-center justify-between px-4 pb-3.5 pt-1">
          <span className="text-[12.5px] text-fg-dim">{t('mk.prompt.free', 'Free to start, no credit card')}</span>
          <button type="submit" aria-label={t('mk.prompt.send', 'Start building')}
            className="size-9 rounded-full bg-fg text-panel grid place-items-center hover:opacity-85 transition-opacity cursor-pointer">
            <ArrowUp className="size-4" strokeWidth={2.25} />
          </button>
        </div>
      </form>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {examples.map((e) => (
          <button key={e} type="button" onClick={() => setText(e)}
            className="h-8 px-3.5 rounded-full border border-edge text-[13px] text-fg-mid hover:text-fg hover:border-edge-strong transition-colors cursor-pointer">
            {e}
          </button>
        ))}
      </div>
    </div>
  )
}
