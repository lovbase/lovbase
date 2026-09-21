import { useCallback, useEffect, useState } from 'react'
import { MiniApp } from './MiniApp'
import { useI18n } from '../lib/i18n'

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

type Scene = { prompt: { zh: string; en: string }; app: { zh: string; en: string }; tables: { zh: string; en: string }[] }

const SCENES: Scene[] = [
  {
    prompt: { zh: '做一个客户管理系统,记录客户、联系人和跟进', en: 'A CRM that tracks customers, contacts and follow-ups' },
    app: { zh: '客户管理', en: 'Customers' },
    tables: [{ zh: '客户', en: 'Customers' }, { zh: '联系人', en: 'Contacts' }, { zh: '商机', en: 'Deals' }, { zh: '跟进记录', en: 'Follow-ups' }],
  },
  {
    prompt: { zh: '库存台账,商品出入库和供应商', en: 'Stock ledger with movements and suppliers' },
    app: { zh: '库存台账', en: 'Inventory' },
    tables: [{ zh: '商品', en: 'Items' }, { zh: '出入库', en: 'Movements' }, { zh: '供应商', en: 'Suppliers' }],
  },
  {
    prompt: { zh: '活动报名,带签到状态', en: 'Event sign-ups, with a check-in state' },
    app: { zh: '活动报名', en: 'Sign-ups' },
    tables: [{ zh: '活动', en: 'Events' }, { zh: '报名人', en: 'Attendees' }, { zh: '签到', en: 'Check-ins' }],
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
  const { locale } = useI18n()
  const [scene, setScene] = useState(0)
  // Keyed by scene, so each one mounts fresh and starts from nothing. Resetting counters inside an
  // effect would be a second render for state that a remount gives for free.
  // Stable, so the reel's timers are not torn down and restarted by a parent re-render.
  const next = useCallback(() => setScene((n) => (n + 1) % SCENES.length), [])
  return (
    <Reel key={`${scene}-${locale}`} scene={SCENES[scene]} en={locale === 'en'} onDone={next}
      dots={<Dots count={SCENES.length} active={scene} onPick={setScene} en={locale === 'en'} />} />
  )
}

/**
 * Which of the three is showing, and a way to choose. A loop with no control is a loop you have to
 * wait out: the one you wanted has just gone, and the only way back is round again.
 */
function Dots({ count, active, onPick, en }: { count: number; active: number; onPick: (i: number) => void; en: boolean }) {
  return (
    <div className="mt-8 flex items-center gap-2">
      {Array.from({ length: count }, (_, i) => (
        <button key={i} type="button" onClick={() => onPick(i)}
          aria-label={en ? `Example ${i + 1}` : `第 ${i + 1} 个例子`} aria-current={i === active}
          className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer
                      ${i === active ? 'w-7 bg-fg' : 'w-1.5 bg-edge-strong hover:bg-fg-dim'}`} />
      ))}
    </div>
  )
}

function Reel({ scene, en, onDone, dots }: { scene: Scene; en: boolean; onDone: () => void; dots: React.ReactNode }) {
  const prompt = en ? scene.prompt.en : scene.prompt.zh
  const tables = scene.tables.map((t) => (en ? t.en : t.zh))

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
        <p className="eyebrow mb-6">{en ? 'One sentence, a working app · on real Postgres' : '一句话,一个能用的应用 · 底下是真 Postgres'}</p>

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
            <MiniApp name={en ? scene.app.en : scene.app.zh} tables={tables} className="h-40" />
          </div>
        </div>

        {dots}
      </div>
    </div>
  )
}
