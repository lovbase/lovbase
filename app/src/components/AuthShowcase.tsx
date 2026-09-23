import { useCallback, useEffect, useState } from 'react'
import { MiniApp } from './MiniApp'
import { useI18n, useT } from '../lib/i18n'

/**
 * The half of the sign-in page that is not a form.
 *
 * A login screen has nothing to say for itself, so most of them decorate: a gradient, a mesh, an
 * orbiting blob. This one shows the product instead — a sentence types itself, the tables it
 * implies appear one at a time, and an interface assembles out of them. That is the whole pitch,
 * and it is the only thing on this page a visitor has any reason to look at.
 *
 * Built from what the app already draws: the dot ground from the home canvas and the same MiniApp
 * wireframe the project cards use. No new dependency, and nothing here that the rest of the
 * product does not already say in the same visual language.
 */

type T = ReturnType<typeof useT>
type Scene = { prompt: string; app: string; tables: string[] }

const scenes = (t: T): Scene[] => [
  {
    prompt: t('auth.showcase.crm.prompt', 'A CRM that tracks customers, contacts and follow-ups'),
    app: t('auth.showcase.crm.app', 'Customers'),
    tables: [
      t('auth.showcase.crm.t0', 'Customers'),
      t('auth.showcase.crm.t1', 'Contacts'),
      t('auth.showcase.crm.t2', 'Deals'),
      t('auth.showcase.crm.t3', 'Follow-ups'),
    ],
  },
  {
    prompt: t('auth.showcase.stock.prompt', 'Stock ledger with movements and suppliers'),
    app: t('auth.showcase.stock.app', 'Inventory'),
    tables: [
      t('auth.showcase.stock.t0', 'Items'),
      t('auth.showcase.stock.t1', 'Movements'),
      t('auth.showcase.stock.t2', 'Suppliers'),
    ],
  },
  {
    prompt: t('auth.showcase.events.prompt', 'Event sign-ups, with a check-in state'),
    app: t('auth.showcase.events.app', 'Sign-ups'),
    tables: [
      t('auth.showcase.events.t0', 'Events'),
      t('auth.showcase.events.t1', 'Attendees'),
      t('auth.showcase.events.t2', 'Check-ins'),
    ],
  },
]

/** Milliseconds per character, and the pauses between the three beats. */
const TYPE_MS = 45
const AFTER_TYPE = 500
const PER_TABLE = 260
const HOLD = 3200

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function AuthShowcase() {
  const { locale, t } = useI18n()
  const SCENES = scenes(t)
  const count = SCENES.length
  const [scene, setScene] = useState(0)
  // Keyed by scene, so each one mounts fresh and starts from nothing. Resetting counters inside an
  // effect would be a second render for state that a remount gives for free.
  // Stable, so the reel's timers are not torn down and restarted by a parent re-render.
  const next = useCallback(() => setScene((n) => (n + 1) % count), [count])
  return (
    <Reel key={`${scene}-${locale}`} scene={SCENES[scene]} onDone={next}
      dots={<Dots count={count} active={scene} onPick={setScene} />} />
  )
}

/**
 * Which of the three is showing, and a way to choose. A loop with no control is a loop you have to
 * wait out: the one you wanted has just gone, and the only way back is round again.
 */
function Dots({ count, active, onPick }: { count: number; active: number; onPick: (i: number) => void }) {
  const t = useT()
  return (
    <div className="mt-8 flex items-center gap-2">
      {Array.from({ length: count }, (_, i) => (
        <button key={i} type="button" onClick={() => onPick(i)}
          aria-label={t('auth.showcase.example', 'Example {n}').replace('{n}', String(i + 1))} aria-current={i === active}
          className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer
                      ${i === active ? 'w-7 bg-fg' : 'w-1.5 bg-edge-strong hover:bg-fg-dim'}`} />
      ))}
    </div>
  )
}

function Reel({ scene, onDone, dots }: { scene: Scene; onDone: () => void; dots: React.ReactNode }) {
  const t = useT()
  const { prompt, tables } = scene

  // Reduced motion gets the finished picture and no loop: the point is what gets built, not the
  // building of it, and that reads perfectly well standing still.
  const still = reducedMotion()
  const [typed, setTyped] = useState(() => (still ? prompt.length : 0))
  const [revealed, setRevealed] = useState(() => (still ? tables.length : 0))
  useEffect(() => {
    if (still) return
    const ids: ReturnType<typeof setTimeout>[] = []
    const at = (ms: number, fn: () => void) => ids.push(setTimeout(fn, ms))
    for (let i = 1; i <= prompt.length; i++) at(i * TYPE_MS, () => setTyped(i))
    const typingDone = prompt.length * TYPE_MS + AFTER_TYPE
    for (let i = 1; i <= tables.length; i++) at(typingDone + i * PER_TABLE, () => setRevealed(i))
    at(typingDone + tables.length * PER_TABLE + HOLD, onDone)
    return () => { for (const id of ids) clearTimeout(id) }
  }, [still, prompt, tables.length, onDone])

  const built = revealed >= tables.length

  return (
    <div className="relative h-full overflow-hidden">
      <div className="hero-wash hero-wash--column absolute inset-0" aria-hidden />

      <div className="relative h-full flex flex-col justify-center px-12 xl:px-20 max-w-[36rem] mx-auto">
        <p className="eyebrow mb-6">{t('auth.showcase.eyebrow', 'One sentence, a working app · on real Postgres')}</p>

        {/* the sentence, typing */}
        <p className="font-mono text-[15px] leading-relaxed text-fg min-h-[3.5rem]">
          {prompt.slice(0, typed)}
          <span className="lb-caret" aria-hidden />
        </p>

        {/* the tables it implies */}
        <div className="mt-7 flex flex-wrap gap-2 min-h-[4.5rem] content-start">
          {tables.map((name, i) => (
            <span key={name}
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-edge bg-panel
                          text-[12.5px] whitespace-nowrap transition-all duration-500
                          ${i < revealed ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1.5'}`}>
              <span className="size-1.5 rounded-full bg-ok" />
              {name}
            </span>
          ))}
        </div>

        {/* and the interface that comes out */}
        <div className={`mt-8 transition-all duration-700 ${built ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'}`}>
          <div className="panel-card overflow-hidden p-2">
            <MiniApp name={scene.app} tables={tables} className="h-40" />
          </div>
        </div>

        {dots}
      </div>
    </div>
  )
}
