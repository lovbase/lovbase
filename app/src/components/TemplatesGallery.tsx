import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Dialog } from '@base-ui/react/dialog'
import { ArrowRight, Copy, ExternalLink, Loader2, Search, X } from 'lucide-react'
import { templates, type TemplateLocale } from '@lovbase/core/templates'
import type { InventoryClient } from '@lovbase/core/inventory'
import type { Product3dClient } from '@lovbase/core/product-3d'
import type { CommunityTemplate, TemplateCategory } from '@lovbase/api'
import { createProjectFromTemplate, getCommunityTemplate, getCommunityTemplates, getTemplate, useCommunityTemplate } from '../functions/templates'
import { useI18n } from '../lib/i18n'
import { LocaleToggle } from './LocaleToggle'
import { Logo } from './Logo'

const InventoryApp = lazy(() =>
  import('../../../templates/inventory/src/InventoryApp').then((m) => ({
    default: m.InventoryApp,
  })),
)
const ProductStudio = lazy(() =>
  import('../../../templates/product-3d/src/ProductStudio').then((m) => ({
    default: m.ProductStudio,
  })),
)
const labels = {
  title: ['从模板开始', 'Start with a template'],
  subtitle: ['好用的起点，属于你的应用。', 'A considered starting point. An app of your own.'],
  search: ['搜索模板…', 'Search templates…'],
  all: ['全部', 'All'],
  empty: ['没有找到匹配的模板', 'No matching templates'],
  use: ['使用模板', 'Use template'],
  close: ['关闭', 'Close'],
  remix: ['Remix 项目', 'Remix project'],
  explain: [
    '创建一份属于你的应用副本，包含独立的示例数据，之后可继续编辑。',
    'Create a copy you own, with independent sample data, ready to make your own.',
  ],
  name: ['项目名称', 'Project name'],
  cancel: ['取消', 'Cancel'],
  confirm: ['创建副本', 'Remix project'],
  creating: ['正在创建副本…', 'Creating your copy…'],
  loading: ['正在加载模板…', 'Loading template…'],
  error: ['暂时无法完成，请重试。', 'Something went wrong. Please try again.'],
  limit: [
    '已达到项目数量上限。请释放项目名额或升级套餐。',
    'You have reached your project limit. Free up a project slot or upgrade your plan.',
  ],
  retry: ['重试', 'Retry'],
  author: ['由 Lovbase 提供', 'by Lovbase'],
  browse: ['全部模板', 'All templates'],
  featured: ['精选', 'Featured'],
  by: ['作者', 'by'],
  uses: ['次使用', 'uses'],
  tables: ['张表', 'tables'],
  communityExplain: [
    '新建一个项目，带上相同的表结构和界面。不包含原作者的数据。',
    'A new project with the same tables and interface. None of the author’s data comes with it.',
  ],
  noLive: ['作者已下线这个应用，暂时只能看封面。', 'The author has taken this app offline; only the cover is available.'],
  openLive: ['新窗口打开', 'Open in new tab'],
} satisfies Record<string, [string, string]>
type Stage = 'closed' | 'preview' | 'community' | 'remix'

/** Built-in and community templates, in the one shape the grid draws. */
type Card = {
  key: string
  kind: 'builtin' | 'community'
  id: string
  name: string
  description: string
  categoryId: string | null
  cover: string | null
  author: string
  featured: boolean
  uses: number
}

export function TemplatesGallery({
  signedIn,
  compact = false,
  seoUrl = false,
  initialTemplate,
  initialRemix = false,
  initialCommunity,
}: {
  signedIn: boolean
  compact?: boolean
  seoUrl?: boolean
  initialTemplate?: string
  initialRemix?: boolean
  initialCommunity?: string
}) {
  const { locale, setLocale } = useI18n()
  const t = (key: keyof typeof labels) => labels[key][locale === 'zh' ? 0 : 1]
  const router = useRouter()
  const load = useServerFn(getTemplate)
  const remix = useServerFn(createProjectFromTemplate)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [selected, setSelected] = useState<string | null>(
    initialTemplate && templates.some((t) => t.id === initialTemplate) ? initialTemplate : null,
  )
  const [stage, setStage] = useState<Stage>(
    selected ? (initialRemix && signedIn ? 'remix' : 'preview') : 'closed',
  )
  const [data, setData] = useState<Awaited<ReturnType<typeof getTemplate>> | null>(null)
  const [name, setName] = useState(() => {
    const initial = templates.find((item) => item.id === selected)
    return initial && initialRemix
      ? locale === 'zh'
        ? `${initial.name.zh}副本`
        : `Remix of ${initial.name.en}`
      : ''
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const loadCommunity = useServerFn(getCommunityTemplates)
  const loadOne = useServerFn(getCommunityTemplate)
  const useCommunity = useServerFn(useCommunityTemplate)
  const [community, setCommunity] = useState<{ categories: TemplateCategory[]; items: CommunityTemplate[] }>({ categories: [], items: [] })
  const [browsing, setBrowsing] = useState(false)
  const [picked, setPicked] = useState<Awaited<ReturnType<typeof getCommunityTemplate>> | null>(null)
  useEffect(() => { void loadCommunity().then(setCommunity).catch(() => {}) }, [loadCommunity])
  // A shared link, or the way back from signing in, opens straight on that template.
  useEffect(() => {
    if (initialCommunity) openCommunity(initialCommunity)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCommunity])
  const request = useRef<string | null>(null)
  const formState = useRef<{ template: string; name: string } | null>(null)
  const template = templates.find((t) => t.id === selected)
  const currentName = template?.name[locale] ?? ''
  const cards = useMemo<Card[]>(() => [
    ...templates.map((b) => ({
      key: b.id, kind: 'builtin' as const, id: b.id, name: b.name[locale], description: b.description[locale],
      categoryId: b.categoryId, cover: b.cover, author: 'Lovbase', featured: true, uses: 0,
    })),
    ...community.items.map((c) => ({
      key: `c:${c.id}`, kind: 'community' as const, id: c.id, name: c.name, description: c.description,
      categoryId: c.categoryId, cover: c.coverUrl, author: c.author, featured: c.featured, uses: c.uses,
    })),
  ], [community.items, locale])
  // Categories come from the admin's list; before it loads, the built-ins' own labels stand in.
  const categories = community.categories.length
    ? community.categories.map((c) => ({ id: c.id, name: locale === 'zh' ? c.nameZh : c.nameEn }))
    : Array.from(new Map(templates.map((b) => [b.categoryId, { id: b.categoryId as string, name: b.category[locale] }])).values())
  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? ''
  const used = categories.filter((c) => cards.some((card) => card.categoryId === c.id))
  const filtered = cards.filter(
    (c) =>
      (!category || (category === 'featured' ? c.featured : c.categoryId === category)) &&
      `${c.name} ${c.description} ${c.author}`.toLowerCase().includes(query.toLowerCase()),
  )
  const featuredCards = cards.filter((c) => c.featured).slice(0, 6)
  const demoClient = useMemo<InventoryClient>(
    () => ({
      read: async () => {
        const result = await load({ data: { templateId: 'inventory' } })
        if (result.templateId !== 'inventory') throw new Error('invalid_template')
        return result.data
      },
      command: async () => {
        throw new Error('read_only')
      },
    }),
    [load, selected],
  )
  const productClient = useMemo<Product3dClient>(
    () => ({
      read: async () => {
        const result = await load({ data: { templateId: 'product-3d' } })
        if (result.templateId !== 'product-3d') throw new Error('invalid_template')
        return result.data
      },
      command: async () => {
        throw new Error('read_only')
      },
    }),
    [load],
  )
  const selectedRef = useRef(selected)
  const loadDemo = useCallback(
    async (id: string) => {
      setLoading(true)
      setError('')
      try {
        const result = await load({ data: { templateId: id } })
        if (selectedRef.current === id) setData(result)
      } catch {
        if (selectedRef.current === id) setError('error')
      } finally {
        if (selectedRef.current === id) setLoading(false)
      }
    },
    [load],
  )
  useEffect(() => {
    selectedRef.current = selected
    if (!selected) return
    void loadDemo(selected)
    try {
      const draft = JSON.parse(sessionStorage.getItem('lovbase.template-remix') || 'null') as {
        template: string
        name: string
      } | null
      if (draft?.template === selected) {
        setName(draft.name)
        formState.current = draft
      }
    } catch {}
  }, [selected, loadDemo])
  function pick(card: Card) {
    setBrowsing(false)
    if (card.kind === 'builtin') return open(card.id)
    openCommunity(card.id)
  }
  function openCommunity(id: string) {
    setSelected(null)
    setPicked(null)
    setError('')
    setName('')
    request.current = null
    setStage('community')
    void loadOne({ data: { id } }).then(setPicked).catch(() => setError('error'))
  }
  function open(id: string) {
    setSelected(id)
    if (selected !== id) setData(null)
    setError('')
    setStage('preview')
    request.current = null
    if (formState.current?.template !== id) {
      setName('')
      formState.current = null
    }
  }
  function defaultName() {
    const of = picked && stage !== 'preview' && !template ? picked.name : currentName
    return locale === 'zh' ? `${of}副本` : `Remix of ${of}`
  }
  function useCommunityCard() {
    if (!picked) return
    if (!signedIn) {
      void router.navigate({ to: '/login', search: { returnTo: `/templates?community=${picked.id}` } })
      return
    }
    setName(name || defaultName())
    setError('')
    setStage('remix')
  }
  function useTemplate() {
    if (!template) return
    const chosenName = name || defaultName()
    setName(chosenName)
    formState.current = { template: template.id, name: chosenName }
    if (!signedIn) {
      try {
        sessionStorage.setItem('lovbase.template-remix', JSON.stringify(formState.current))
      } catch {}
      void router.navigate({
        to: '/login',
        search: { returnTo: `/templates?template=${template.id}&remix=1` },
      })
      return
    }
    setError('')
    setStage('remix')
  }
  async function confirm(e: React.FormEvent) {
    e.preventDefault()
    if ((!template && !picked) || busy || !name.trim()) return
    setBusy(true)
    setError('')
    request.current ??= crypto.randomUUID()
    try {
      const result = !template && picked ? await useCommunity({ data: { id: picked.id, name: name.trim(), requestId: request.current } }) : await remix({
        data: {
          templateId: template!.id,
          version: template!.version,
          name: name.trim(),
          locale,
          requestId: request.current,
        },
      })
      try {
        sessionStorage.removeItem('lovbase.template-remix')
      } catch {}
      await router.navigate({
        to: '/projects/$projectId',
        params: { projectId: result.projectId },
      })
    } catch (e) {
      setError(e instanceof Error && e.message.includes('LIMIT:') ? 'limit' : 'error')
    } finally {
      setBusy(false)
    }
  }
  const grid = (list: Card[], dense = false) => (
    <div className={`grid grid-cols-1 sm:grid-cols-2 ${dense ? 'lg:grid-cols-3 gap-5' : 'xl:grid-cols-3 gap-7'}`}>
      {list.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => pick(item)}
          className="text-left group cursor-pointer rounded-2xl focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-4"
        >
          <div className="overflow-hidden rounded-2xl border border-edge bg-panel-2 aspect-[1.65] shadow-sm">
            {item.cover ? (
              <img
                src={item.cover}
                alt={item.name}
                loading="lazy"
                className="w-full h-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.025]"
              />
            ) : (
              <div className="w-full h-full grid place-items-center font-display text-4xl text-fg-dim/50">{item.name.slice(0, 1)}</div>
            )}
          </div>
          <p className={`${dense ? 'mt-3 text-[14.5px]' : 'mt-4 text-[16px]'} font-medium group-hover:text-accent transition-colors truncate`}>
            {item.name}
          </p>
          <p className="mt-1.5 text-[12.5px] text-fg-dim truncate">
            {[categoryName(item.categoryId), item.kind === 'builtin' ? 'Lovbase' : item.author, item.uses ? `${item.uses} ${t('uses')}` : '']
              .filter(Boolean)
              .join(' · ')}
          </p>
        </button>
      ))}
    </div>
  )
  const chips = (
    <div className="flex flex-wrap gap-2">
      {[{ id: '', name: t('all') }, { id: 'featured', name: t('featured') }, ...used].map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => setCategory(c.id)}
          className={`h-8 px-3.5 rounded-full text-[13px] transition-colors cursor-pointer ${
            category === c.id ? 'bg-fg text-ink' : 'bg-panel border border-edge text-fg-mid hover:text-fg'
          }`}
        >
          {c.name}
        </button>
      ))}
    </div>
  )
  const searchBox = (
    <label className="flex items-center gap-2 h-9 px-3 bg-panel border border-edge rounded-xl">
      <Search size={15} className="text-fg-dim" />
      <input
        aria-label={t('search')}
        placeholder={t('search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="bg-transparent outline-none text-[13.5px] w-44"
      />
    </label>
  )
  return (
    <section className={compact ? 'relative z-10 px-6 pb-12 w-full max-w-6xl mx-auto' : 'w-full'}>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-7">
        <div>
          <h2 className="font-display text-2xl font-medium tracking-tight">{t('title')}</h2>
          <p className="text-fg-dim text-sm mt-2">{t('subtitle')}</p>
        </div>
        {compact ? (
          <button
            type="button"
            onClick={() => { setCategory(''); setQuery(''); setBrowsing(true) }}
            className="inline-flex items-center gap-1.5 text-[13.5px] text-fg-mid hover:text-fg cursor-pointer"
          >
            {t('browse')} <ArrowRight size={14} />
          </button>
        ) : (
          <LocaleToggle seoUrl={seoUrl} />
        )}
      </div>
      {compact ? (
        grid(featuredCards)
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-8">
            {chips}
            {searchBox}
          </div>
          {grid(filtered)}
          {!filtered.length && <p className="py-20 text-center text-fg-dim">{t('empty')}</p>}
        </>
      )}
      <Dialog.Root open={browsing} onOpenChange={setBrowsing}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Popup className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-2rem)] max-w-[1120px] h-[min(820px,calc(100vh-2rem))] rounded-2xl bg-panel text-fg shadow-2xl overflow-hidden flex max-sm:flex-col focus:outline-none">
            <nav className="sm:w-52 shrink-0 bg-ink/60 sm:border-r border-edge p-3 flex flex-col gap-1 max-sm:flex-row max-sm:overflow-x-auto max-sm:border-b">
              <Dialog.Title className="max-sm:hidden px-2.5 pt-1.5 pb-3 text-[12px] font-medium text-fg-dim">{t('browse')}</Dialog.Title>
              {[{ id: '', name: t('all') }, { id: 'featured', name: t('featured') }, ...used].map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategory(c.id)}
                  className={`w-full max-sm:w-auto flex items-center justify-between h-9 px-2.5 rounded-lg text-[13.5px] whitespace-nowrap transition-colors cursor-pointer ${
                    category === c.id ? 'bg-panel text-fg font-medium ring-1 ring-edge shadow-[0_1px_2px_rgba(0,0,0,.06)]' : 'text-fg-mid hover:text-fg hover:bg-panel/70'
                  }`}
                >
                  {c.name}
                  <span className="text-[12px] text-fg-dim tabular-nums max-sm:hidden">
                    {cards.filter((card) => !c.id || (c.id === 'featured' ? card.featured : card.categoryId === c.id)).length}
                  </span>
                </button>
              ))}
            </nav>
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex items-center justify-between gap-3 px-6 sm:px-8 pt-6 pb-4">
                {searchBox}
                <Dialog.Close aria-label={t('close')} className="size-8 grid place-items-center rounded-lg text-fg-dim hover:text-fg hover:bg-panel-2 cursor-pointer">
                  <X size={16} />
                </Dialog.Close>
              </div>
              <div className="flex-1 overflow-y-auto px-6 sm:px-8 pb-8">
                {grid(filtered, true)}
                {!filtered.length && <p className="py-20 text-center text-fg-dim">{t('empty')}</p>}
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={stage === 'community'}
        onOpenChange={(open) => {
          if (!open) setStage('closed')
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
          <Dialog.Popup className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[96vw] max-w-[1440px] h-[90vh] rounded-2xl bg-panel shadow-2xl overflow-hidden flex flex-col focus:outline-none">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 p-4 sm:px-6 border-b border-edge">
              <div className="min-w-0">
                <Dialog.Title className="text-base font-medium truncate">
                  {picked?.name ?? ''}
                  {picked && (
                    <span className="hidden sm:inline text-fg-dim font-normal ml-2 text-sm">
                      {t('by')} {picked.author} · {picked.tables} {t('tables')}
                    </span>
                  )}
                </Dialog.Title>
                {picked?.description && <p className="text-[13px] text-fg-dim mt-0.5 truncate">{picked.description}</p>}
              </div>
              <div className="flex items-center gap-3">
                {picked?.liveUrl && (
                  <a href={picked.liveUrl} target="_blank" rel="noreferrer" className="hidden sm:inline-flex items-center gap-1.5 text-[13px] text-fg-mid hover:text-fg">
                    <ExternalLink size={14} /> {t('openLive')}
                  </a>
                )}
                <button
                  disabled={!picked}
                  className="px-4 py-2 bg-fg text-ink rounded-lg text-sm font-medium cursor-pointer hover:opacity-85 disabled:opacity-40"
                  onClick={useCommunityCard}
                >
                  {t('use')}
                </button>
                <button aria-label={t('close')} className="p-1.5 text-fg-dim hover:text-fg cursor-pointer" onClick={() => setStage('closed')}>
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-auto bg-panel-2">
              {!picked ? (
                error ? (
                  <p className="p-12 text-center">{t('error')}</p>
                ) : (
                  <p className="flex items-center justify-center gap-2 h-full text-fg-dim">
                    <Loader2 className="animate-spin" size={18} />
                    {t('loading')}
                  </p>
                )
              ) : picked.liveUrl ? (
                <iframe src={picked.liveUrl} title={picked.name} className="h-full w-full border-0 bg-white" sandbox="allow-scripts allow-same-origin allow-forms" />
              ) : (
                <div className="h-full grid place-items-center p-8">
                  <div className="max-w-3xl w-full">
                    {picked.coverUrl && <img src={picked.coverUrl} alt={picked.name} className="w-full rounded-xl border border-edge shadow-sm" />}
                    <p className="mt-4 text-center text-[13px] text-fg-dim">{t('noLive')}</p>
                  </div>
                </div>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={stage === 'preview'}
        onOpenChange={(open) => {
          if (!open) setStage('closed')
        }}
      >
        <Dialog.Portal keepMounted>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] data-closed:hidden" />
          <Dialog.Popup className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[96vw] max-w-[1440px] h-[90vh] rounded-2xl bg-panel shadow-2xl overflow-hidden flex flex-col data-closed:hidden focus:outline-none">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 p-4 sm:px-6 border-b border-edge">
              <Dialog.Title className="text-base font-medium">
                {currentName}
                <span className="hidden sm:inline text-fg-dim font-normal ml-2 text-sm">
                  {t('author')}
                </span>
              </Dialog.Title>
              <div className="flex items-center gap-3">
                <LocaleToggle />
                <button
                  className="px-4 py-2 bg-fg text-ink rounded-lg text-sm font-medium cursor-pointer hover:opacity-85"
                  onClick={useTemplate}
                >
                  {t('use')}
                </button>
                <button
                  aria-label={t('close')}
                  className="p-1.5 text-fg-dim hover:text-fg cursor-pointer"
                  onClick={() => setStage('closed')}
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-auto bg-panel-2">
              {loading && !data ? (
                <p className="flex items-center justify-center gap-2 h-full text-fg-dim">
                  <Loader2 className="animate-spin" size={18} />
                  {t('loading')}
                </p>
              ) : data ? (
                <Suspense fallback={<p className="p-10">{t('loading')}</p>}>
                  {data.templateId === 'inkwave' ? (
                    stage === 'preview' && (
                      <iframe
                        key={locale}
                        src={`${data.previewUrl}?lang=${locale}`}
                        title={currentName}
                        className="h-full min-h-[360px] w-full border-0 bg-black"
                        allow="fullscreen; autoplay; clipboard-write"
                        allowFullScreen
                      />
                    )
                  ) : data.templateId === 'inventory' ? (
                    <InventoryApp
                      client={demoClient}
                      initialData={data.data}
                      locale={locale}
                      onLocaleChange={(l) => setLocale(l as TemplateLocale)}
                    />
                  ) : (
                    <ProductStudio
                      client={productClient}
                      initialData={data.data}
                      locale={locale}
                      onLocaleChange={setLocale}
                    />
                  )}
                </Suspense>
              ) : (
                <div className="p-12 text-center">
                  <p>{t('error')}</p>
                  <button
                    className="mt-4 underline cursor-pointer"
                    onClick={() => selected && void loadDemo(selected)}
                  >
                    {t('retry')}
                  </button>
                </div>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={stage === 'remix'}
        onOpenChange={(open) => {
          if (!open && !busy) setStage(template ? 'preview' : 'community')
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
          <Dialog.Popup className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-32px)] max-w-[460px] rounded-2xl bg-panel text-fg p-7 shadow-2xl focus:outline-none">
            <Logo size={36} />
            <button
              disabled={busy}
              aria-label={t('close')}
              className="absolute right-5 top-5 text-fg-dim cursor-pointer disabled:opacity-50"
              onClick={() => setStage(template ? 'preview' : 'community')}
            >
              <X size={18} />
            </button>
            <Dialog.Title className="text-2xl font-semibold tracking-tight mt-6">
              {t('remix')}
            </Dialog.Title>
            <Dialog.Description className="text-sm text-fg-dim leading-6 mt-3">
              {t(template ? 'explain' : 'communityExplain')}
            </Dialog.Description>
            <form onSubmit={confirm}>
              <label className="block mt-6 text-sm font-medium">
                {t('name')}
                <input
                  autoFocus
                  required
                  maxLength={80}
                  disabled={busy}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (selected) formState.current = {
                      template: selected,
                      name: e.target.value,
                    }
                  }}
                  className="block w-full mt-2 px-3 py-2.5 rounded-lg border border-edge bg-panel-2 focus:outline-2 focus:outline-accent text-sm"
                />
              </label>
              {error && (
                <p role="alert" className="mt-4 text-sm text-accent-soft">
                  {t(error === 'limit' ? 'limit' : 'error')}
                </p>
              )}
              <div className="mt-7 flex justify-end gap-2">
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => setStage(template ? 'preview' : 'community')}
                  className="px-4 py-2 border border-edge rounded-lg cursor-pointer text-sm disabled:opacity-50"
                >
                  {t('cancel')}
                </button>
                <button
                  disabled={busy || !name.trim()}
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-fg text-ink inline-flex gap-2 items-center text-sm cursor-pointer disabled:opacity-50"
                >
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <Copy size={15} />}{' '}
                  {t(busy ? 'creating' : 'confirm')}
                </button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  )
}
