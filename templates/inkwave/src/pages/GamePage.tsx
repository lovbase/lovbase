import { useEffect, useRef, useState } from 'react'
import { X, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HomeScreenTip } from '@/components/HomeScreenTip'
import { defaultLocale } from '../template-config'

const PROMO = {
  en: {
    label: 'About Lovbase',
    title: 'Built with Lovbase',
    description: 'Turn your ideas into apps you can use.',
    link: 'Game guide & about Lovbase',
    close: 'Close Lovbase popup',
    newWindow: '(opens in a new window)',
  },
  zh: {
    label: 'Lovbase 来源标识',
    title: '由 Lovbase 构建',
    description: '把你的想法，变成可以使用的应用。',
    link: '对战说明与 Lovbase 介绍',
    close: '关闭 Lovbase 来源浮窗',
    newWindow: '（新窗口打开）',
  },
}

// Language is synchronized with the game even outside multiplayer matches.
const TEXT = {
  en: {
    waiting: 'Waiting for players',
    server: 'WSS dedicated server',
    fast: 'Dedicated realtime channel',
    compat: 'Compatibility channel',
    host: 'Host',
    lowFps: 'Low frame rate. Try lowering graphics quality in Settings.',
    congested: 'Network congested, merging stale positions.',
    highPing: 'High network latency. Try playing on the same network.',
  },
  zh: {
    waiting: '等待玩家',
    server: 'WSS 专用服务器',
    fast: '独立实时通道',
    compat: '兼容通道',
    host: '房主',
    lowFps: '画面帧率偏低，可在设置中降低画质。',
    congested: '网络拥堵，正在合并过期位置。',
    highPing: '网络延迟偏高，可尝试同一网络。',
  },
}

export default function GamePage() {
  const [src, setSrc] = useState<string>()
  const [language, setLanguage] = useState<'en' | 'zh' | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const playing = useRef(false)
  const [inMatch, setInMatch] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [metrics, setMetrics] = useState<{
    fps: number
    ping: number | null
    queued: number
    fast: boolean
    server: boolean
    host: boolean
    lang?: string
  } | null>(null)
  useEffect(() => {
    document.documentElement.classList.add('game-active')
    const entry = new URL(`${import.meta.env.BASE_URL}game/index.html`, location.origin)
    entry.search = location.search
    if (!entry.searchParams.has('lang')) entry.searchParams.set('lang', defaultLocale)
    entry.hash = location.hash
    setSrc(entry.href)
    const receive = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return
      if (e.data?.type === 'inkwave-language' && ['en', 'zh'].includes(e.data.lang)) {
        setLanguage(e.data.lang)
        return
      }
      if (e.data?.type === 'inkwave-play-state' && typeof e.data.active === 'boolean') {
        if (playing.current && !e.data.active) setDismissed(false)
        playing.current = e.data.active
        setInMatch(e.data.active)
        return
      }
      if (e.data?.type === 'inkwave-invite' && typeof e.data.search === 'string') {
        const next = new URLSearchParams(e.data.search)
        const url = new URL(location.href)
        for (const key of ['mode', 'room', 'server', 'key', 'lobby']) {
          url.searchParams.delete(key)
          if (next.has(key)) url.searchParams.set(key, next.get(key)!)
        }
        url.hash = ''
        history.replaceState(null, '', url.pathname + url.search)
        return
      }
      if (e.data?.type !== 'inkwave-metrics') return
      setMetrics(e.data.active ? e.data : null)
    }
    addEventListener('message', receive)
    return () => {
      removeEventListener('message', receive)
      document.documentElement.classList.remove('game-active')
    }
  }, [])
  const t = TEXT[language ?? 'en']
  const promo = PROMO[language ?? 'en']
  return (
    <main
      className="game-viewport fixed inset-0 h-dvh w-full overflow-hidden bg-black"
      aria-label="INKWAVE 游戏区域"
    >
      {src && (
        <iframe
          ref={frame}
          src={src}
          title="INKWAVE · Turf War"
          className="game-frame block h-full w-full border-0"
          allow="fullscreen; autoplay; clipboard-write"
          allowFullScreen
        />
      )}
      {language && <HomeScreenTip language={language} inMatch={inMatch} />}
      {language && !inMatch && !dismissed && (
        <aside
          lang={language === 'zh' ? 'zh-CN' : 'en'}
          aria-label={promo.label}
          className="dark fixed right-4 bottom-4 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-border/60 bg-background/55 p-5 text-foreground shadow-xl backdrop-blur-xl"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="absolute top-2 right-2 size-8 p-0"
            aria-label={promo.close}
            onClick={() => setDismissed(true)}
          >
            <X className="size-4" />
          </Button>
          <p className="pr-7 text-sm font-semibold">{promo.title}</p>
          <p className="mt-2 text-sm text-muted-foreground">{promo.description}</p>
          <a
            href={`${import.meta.env.BASE_URL}guide?lang=${language ?? 'en'}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            {promo.link}
            <ArrowUpRight className="size-4" aria-hidden="true" />
            <span className="sr-only">{promo.newWindow}</span>
          </a>
        </aside>
      )}
      {metrics && (
        <div
          className="pointer-events-none absolute bottom-3 left-3 z-50 [@media(any-pointer:coarse)]:bottom-auto [@media(any-pointer:coarse)]:top-1 [@media(any-pointer:coarse)]:max-w-40 [@media(any-pointer:coarse)]:px-2 [@media(any-pointer:coarse)]:py-1 [@media(any-pointer:coarse)]:text-[9px] rounded-lg border border-white/15 bg-slate-950/85 px-3 py-2 text-xs text-white shadow-lg"
          aria-live="polite"
        >
          <div className="flex flex-wrap gap-x-3 font-mono">
            <span className={metrics.fps < 40 ? 'text-amber-300' : 'text-emerald-300'}>
              {metrics.fps} FPS
            </span>
            <span>{metrics.ping == null ? t.waiting : `${metrics.ping} ms`}</span>
            <span>
              {metrics.server ? t.server : metrics.fast ? t.fast : t.compat}
              {metrics.host ? ` · ${t.host}` : ''}
            </span>
          </div>
          {(metrics.fps < 40 || (metrics.ping ?? 0) > 150 || metrics.queued > 16) && (
            <div className="mt-1 text-amber-200">
              {metrics.fps < 40 ? t.lowFps : metrics.queued > 16 ? t.congested : t.highPing}
            </div>
          )}
        </div>
      )}
    </main>
  )
}
