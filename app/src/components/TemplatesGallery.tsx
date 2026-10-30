import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { Dialog } from '@base-ui/react/dialog'
import { Copy, Loader2, Search, X } from 'lucide-react'
import { templates, type TemplateLocale } from '@lovbase/core/templates'
import type { InventoryClient } from '@lovbase/core/inventory'
import type { Product3dClient } from '@lovbase/core/product-3d'
import { createProjectFromTemplate, getTemplate } from '../functions/templates'
import { useI18n } from '../lib/i18n'
import { LocaleToggle } from './LocaleToggle'
import { Logo } from './Logo'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

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
  all: ['全部模板', 'All templates'],
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
} satisfies Record<string, [string, string]>
type Stage = 'closed' | 'preview' | 'remix'

export function TemplatesGallery({
  signedIn,
  compact = false,
  seoUrl = false,
  initialTemplate,
  initialRemix = false,
}: {
  signedIn: boolean
  compact?: boolean
  seoUrl?: boolean
  initialTemplate?: string
  initialRemix?: boolean
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
  const request = useRef<string | null>(null)
  const formState = useRef<{ template: string; name: string } | null>(null)
  const template = templates.find((t) => t.id === selected)
  const currentName = template?.name[locale] ?? ''
  const filtered = templates.filter(
    (t) =>
      (!category || t.category.en === category) &&
      `${t.name.zh} ${t.name.en} ${t.description.zh} ${t.description.en}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  )
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
    return locale === 'zh' ? `${currentName}副本` : `Remix of ${currentName}`
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
    if (!template || busy || !name.trim()) return
    setBusy(true)
    setError('')
    request.current ??= crypto.randomUUID()
    try {
      const result = await remix({
        data: {
          templateId: template.id,
          version: template.version,
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
  return (
    <section className={compact ? 'relative z-10 px-6 pb-12 w-full max-w-6xl mx-auto' : 'w-full'}>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-7">
        <div>
          <h2 className="font-display text-2xl font-medium tracking-tight">{t('title')}</h2>
          <p className="text-fg-dim text-sm mt-2">{t('subtitle')}</p>
        </div>
        {!compact && <LocaleToggle seoUrl={seoUrl} />}
      </div>
      {!compact && (
        <div className="flex flex-wrap items-center gap-3 mb-8">
          <label className="flex items-center gap-2 px-3 py-2.5 bg-panel border border-edge rounded-xl">
            <Search size={16} className="text-fg-dim" />
            <input
              aria-label={t('search')}
              placeholder={t('search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="bg-transparent outline-none text-sm"
            />
          </label>
          <Select
            value={category}
            onValueChange={(value) => {
              if (value !== null) setCategory(value)
            }}
          >
            <SelectTrigger
              aria-label={t('all')}
              className="px-3 py-2.5 bg-panel border-edge rounded-xl text-sm data-[size=default]:h-auto"
            >
              <SelectValue>
                {(value) =>
                  templates.find((item) => item.category.en === value)?.category[locale] ?? t('all')
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{t('all')}</SelectItem>
              {Array.from(new Map(templates.map((item) => [item.category.en, item.category])).values()).map(
                (item) => (
                  <SelectItem key={item.en} value={item.en}>
                    {item[locale]}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-7">
        {filtered.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => open(item.id)}
            className="text-left group cursor-pointer rounded-2xl focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-4"
          >
            <div className="overflow-hidden rounded-2xl border border-edge bg-panel-2 aspect-[1.65] shadow-sm">
              <img
                src={item.cover}
                alt={item.name[locale]}
                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.025]"
              />
            </div>
            <p className="mt-4 text-[16px] font-medium group-hover:text-accent transition-colors">
              {item.name[locale]}
            </p>
            <span className="inline-block mt-3 text-[10px] uppercase tracking-wider text-fg-dim">
              {item.category[locale]} · 中文 / EN
            </span>
          </button>
        ))}
      </div>
      {!filtered.length && <p className="py-20 text-center text-fg-dim">{t('empty')}</p>}
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
          if (!open && !busy) setStage('preview')
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
              onClick={() => setStage('preview')}
            >
              <X size={18} />
            </button>
            <Dialog.Title className="text-2xl font-semibold tracking-tight mt-6">
              {t('remix')}
            </Dialog.Title>
            <Dialog.Description className="text-sm text-fg-dim leading-6 mt-3">
              {t('explain')}
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
                    formState.current = {
                      template: selected!,
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
                  onClick={() => setStage('preview')}
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
