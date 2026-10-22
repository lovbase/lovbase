import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Layers3,
  Loader2,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import {
  inquiryStatuses,
  localized,
  money,
  quoteProduct,
  type Configuration,
  type Inquiry,
  type InquiryStatus,
  type Locale,
  type Part,
  type Product,
  type Product3dClient,
  type Product3dCommand,
  type Product3dData,
  type Product3dResult,
  type ProductOption,
  type Quote,
} from '@lovbase/core/product-3d'
import { Viewer } from './Viewer'
import { ChairPoster } from './ChairPoster'
import './studio.css'

type Page = 'configure' | 'designs' | 'inquiries' | 'settings'
type Command = Product3dCommand extends infer C
  ? C extends Product3dCommand
    ? Omit<C, 'requestId'>
    : never
  : never
const statusLabels: Record<InquiryStatus, [string, string]> = {
  new: ['待处理', 'New'],
  following: ['跟进中', 'Following up'],
  completed: ['已完成', 'Completed'],
  cancelled: ['已取消', 'Cancelled'],
}
const errors: Record<string, [string, string]> = {
  invalid_input: ['请检查填写内容、金额和数量。', 'Please check the fields, prices and quantity.'],
  invalid_quantity: [
    '数量须为 1–1000 的整数。',
    'Quantity must be a whole number from 1 to 1,000.',
  ],
  option_unavailable: [
    '部分材质已停用，请重新选择后再保存或询价。',
    'A finish is unavailable. Select current finishes before saving or requesting a quote.',
  ],
  invalid_options: [
    '请选择一种椅面和一种支架材质。',
    'Choose one upholstery and one frame finish.',
  ],
  invalid_price: [
    '商品价格无效，请在商品设置中修正。',
    'Invalid pricing. Please correct it in product settings.',
  ],
  record_unavailable: [
    '记录已不存在，请刷新后重试。',
    'This record is no longer available. Refresh and try again.',
  ],
  read_only: [
    '这是只读预览，请使用模板创建自己的项目。',
    'This preview is read-only. Use the template to create your own project.',
  ],
}
function Modal({
  title,
  children,
  close,
}: {
  title: string
  children: ReactNode
  close: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className="studio-dialog"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <button type="button" onClick={close} aria-label="Close / 关闭">
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  )
}
function QuoteSummary({ quote, locale }: { quote: Quote; locale: Locale }) {
  return (
    <div className="studio-summary">
      <div className="studio-mini-chair">
        <ChairPoster
          seat={quote.options.find((o) => o.part === 'seat')?.color}
          frame={quote.options.find((o) => o.part === 'frame')?.color}
        />
      </div>
      <div>
        <strong>{localized(quote.product, locale)}</strong>
        <p>{quote.options.map((o) => localized(o, locale)).join(' / ')}</p>
        <p>
          {quote.quantity} × {money(quote.unit_cents, locale)}
        </p>
        <b>{money(quote.total_cents, locale)}</b>
      </div>
    </div>
  )
}

export function ProductStudio({
  client,
  initialData,
  locale: initialLocale = 'en',
  onLocaleChange,
}: {
  client: Product3dClient
  initialData?: Product3dData
  locale?: Locale
  onLocaleChange?: (locale: Locale) => void
}) {
  const [loadedData, setData] = useState<Product3dData>()
  const data = loadedData ?? initialData
  const [localLocale, setLocale] = useState<Locale>(initialLocale)
  const locale = onLocaleChange ? initialLocale : localLocale
  const [page, setPage] = useState<Page>('configure')
  const [choices, setSelection] = useState<Record<Part, string>>({
    seat: '',
    frame: '',
  })
  const [quantity, setQuantity] = useState(1)
  const [editing, setEditing] = useState<Configuration | null>(null)
  const [modal, setModal] = useState<'save' | 'inquiry' | 'delete' | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Configuration | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(!initialData)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const lock = useRef(false)
  const retry = useRef<{ key: string; requestId: string } | null>(null)
  const t = (zh: string, en: string) => (locale === 'zh' ? zh : en)
  const errorText = (code: string) =>
    errors[code]?.[locale === 'zh' ? 0 : 1] ??
    t('请求失败，请检查连接后重试。', 'Request failed. Check your connection and retry.')
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setData(await client.read())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'request_failed')
    } finally {
      setLoading(false)
    }
  }, [client])
  useEffect(() => {
    if (initialData) return
    let active = true
    client
      .read()
      .then((result) => {
        if (active) setData(result)
      })
      .catch((failure) => {
        if (active) setError(failure instanceof Error ? failure.message : 'request_failed')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [initialData, client])
  const product = data?.products[0]
  const options = useMemo(
    () =>
      (data?.product_options ?? [])
        .filter((o) => o.product_id === product?.id)
        // eslint-disable-next-line unicorn/no-array-sort -- This filtered copy targets ES2022 browsers.
        .sort((a, b) => a.price_cents - b.price_cents || a.name.localeCompare(b.name)),
    [data?.product_options, product?.id],
  )
  const selection = useMemo(
    () => ({
      seat: choices.seat || options.find((o) => o.part === 'seat' && o.enabled)?.id || '',
      frame: choices.frame || options.find((o) => o.part === 'frame' && o.enabled)?.id || '',
    }),
    [choices, options],
  )
  const calculation = useMemo(() => {
    if (!product) return { quote: null, error: '' }
    try {
      return {
        quote: quoteProduct(product, options, {
          productId: product.id,
          optionIds: [selection.seat, selection.frame],
          quantity,
        }),
        error: '',
      }
    } catch (e) {
      return {
        quote: null,
        error: e instanceof Error ? e.message : 'invalid_input',
      }
    }
  }, [product, options, selection, quantity])
  const execute = async (command: Command): Promise<Product3dResult | undefined> => {
    if (lock.current || data?.readOnly) return
    lock.current = true
    setBusy(true)
    setError('')
    setNotice('')
    const key = JSON.stringify(command)
    if (retry.current?.key !== key) retry.current = { key, requestId: crypto.randomUUID() }
    try {
      const result = await client.command({
        ...command,
        requestId: retry.current.requestId,
      } as Product3dCommand)
      setData(await client.read())
      retry.current = null
      return result
    } catch (e) {
      setError(e instanceof Error ? e.message : 'request_failed')
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const navigate = (next: Page) => {
    setPage(next)
    setError('')
    setNotice('')
    setSearch('')
  }
  const reopen = (config: Configuration) => {
    setEditing(config)
    setQuantity(config.quantity)
    setSelection({
      seat: config.snapshot.options.find((o) => o.part === 'seat')?.id ?? '',
      frame: config.snapshot.options.find((o) => o.part === 'frame')?.id ?? '',
    })
    navigate('configure')
  }
  const reset = () => {
    setEditing(null)
    setQuantity(1)
    setSelection({
      seat: options.find((o) => o.part === 'seat' && o.enabled)?.id ?? '',
      frame: options.find((o) => o.part === 'frame' && o.enabled)?.id ?? '',
    })
    navigate('configure')
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!product || !calculation.quote) return
    const form = new FormData(event.currentTarget)
    const selected = {
      productId: product.id,
      optionIds: [selection.seat, selection.frame],
      quantity,
    }
    const command: Command =
      modal === 'save'
        ? {
            action: 'save-configuration',
            ...selected,
            name: String(form.get('name')),
            ...(editing ? { id: editing.id } : {}),
          }
        : {
            action: 'create-inquiry',
            ...selected,
            contact: String(form.get('contact')),
            contactInfo: String(form.get('contactInfo')),
            notes: String(form.get('notes')),
          }
    const result = await execute(command)
    if (!result) return
    if (command.action === 'save-configuration') {
      setEditing({
        id: result.id,
        created_at: editing?.created_at ?? new Date().toISOString(),
        product_id: product.id,
        name: command.name,
        quantity,
        snapshot: result.quote!,
      })
      setNotice(
        t('方案已保存，随时可以回来继续。', 'Design saved. Pick up where you left off anytime.'),
      )
    } else {
      setPage('inquiries')
      setDetail(result.id)
      setNotice(
        t('询价已创建，金额以服务端报价为准。', 'Inquiry created with a confirmed server quote.'),
      )
    }
    setModal(null)
  }
  if (!data || !product)
    return (
      <div className="product-studio studio-loading">
        {loading ? (
          <>
            <Loader2 className="studio-spin" />
            {t('正在准备你的工作室…', 'Preparing your studio…')}
          </>
        ) : (
          <>
            <p role="alert">{errorText(error)}</p>
            <button className="studio-primary" onClick={() => void refresh()}>
              {t('重试', 'Retry')}
            </button>
          </>
        )}
      </div>
    )
  const readOnly = data.readOnly
  const seat =
    options.find((o) => o.id === selection.seat) ??
    editing?.snapshot.options.find((o) => o.part === 'seat')
  const frame =
    options.find((o) => o.id === selection.frame) ??
    editing?.snapshot.options.find((o) => o.part === 'frame')
  const detailInquiry = data.inquiries.find((inquiry) => inquiry.id === detail)
  const shownInquiries = data.inquiries.filter(
    (inquiry) =>
      (filter === 'all' || inquiry.status === filter) &&
      `${inquiry.contact} ${inquiry.contact_info} ${inquiry.notes}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  )
  return (
    <div className="product-studio">
      <header className="studio-header">
        <button className="studio-brand" onClick={() => navigate('configure')}>
          <span className="studio-brand-mark">a</span>
          <span>
            ATELIER<span className="studio-brand-sub">OBJECTS FOR LIVING</span>
          </span>
        </button>
        <nav aria-label={t('工作室导航', 'Studio navigation')}>
          {(
            [
              ['configure', t('定制工作室', 'The studio')],
              ['designs', t('我的方案', 'Saved designs')],
              ['inquiries', t('询价管理', 'Inquiries')],
              ['settings', t('商品设置', 'Product settings')],
            ] as [Page, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => navigate(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="studio-header-end">
          {readOnly && <span className="studio-preview">{t('只读预览', 'PREVIEW')}</span>}
          <button
            className="studio-locale"
            aria-label={t('切换语言', 'Change language')}
            onClick={() => {
              const next = locale === 'zh' ? 'en' : 'zh'
              setLocale(next)
              onLocaleChange?.(next)
            }}
          >
            {locale === 'zh' ? 'EN' : '中文'}
          </button>
        </div>
      </header>
      {error && !modal && (
        <div className="studio-alert" role="alert">
          {errorText(error)}
          <button onClick={() => setError('')} aria-label="Close / 关闭">
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <output className="studio-notice">
          <CheckCircle2 size={17} />
          {notice}
        </output>
      )}
      {page === 'configure' && (
        <>
          <div className="studio-breadcrumb">
            <span>{t('家具', 'Furniture')}</span>
            <ChevronRight size={12} />
            <span>{t('餐椅', 'Dining chairs')}</span>
            <ChevronRight size={12} />
            <b>{localized(product, locale)}</b>
            {editing && <span className="studio-edit-label">{editing.name}</span>}
          </div>
          <main className="studio-configurator">
            <Viewer seat={seat} frame={frame} locale={locale} />
            <aside className="studio-config-panel">
              <div className="studio-eyebrow">THE ARC COLLECTION — NO. 01</div>
              <h1>{localized(product, locale)}</h1>
              <p className="studio-description">
                {locale === 'zh' ? product.description : product.description_en}
              </p>
              <div className="studio-price">
                <strong>
                  {money(calculation.quote?.unit_cents ?? product.price_cents, locale)}
                </strong>
                <span>{t('每把 · 人民币', 'per chair · CNY')}</span>
              </div>
              {(['seat', 'frame'] as Part[]).map((part, index) => (
                <section className="studio-option-group" key={part}>
                  <div className="studio-option-title">
                    <h2>
                      <span>0{index + 1}</span>
                      {part === 'seat'
                        ? t('椅面织物', 'Upholstery')
                        : t('支架饰面', 'Frame finish')}
                    </h2>
                    <small>
                      {part === 'seat' && seat
                        ? localized(seat, locale)
                        : frame
                          ? localized(frame, locale)
                          : '—'}
                    </small>
                  </div>
                  <fieldset
                    className="studio-swatches"
                    aria-label={
                      part === 'seat' ? t('椅面织物', 'Upholstery') : t('支架饰面', 'Frame finish')
                    }
                  >
                    {options
                      .filter((o) => o.part === part && (o.enabled || o.id === selection[part]))
                      .map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          disabled={!option.enabled}
                          aria-pressed={selection[part] === option.id}
                          aria-label={`${localized(option, locale)}${option.enabled ? '' : t('（已停用）', ' (unavailable)')}`}
                          title={`${localized(option, locale)} · +${money(option.price_cents, locale)}`}
                          onClick={() => setSelection({ ...selection, [part]: option.id })}
                        >
                          <span className={`studio-swatch ${part}`}>
                            <svg viewBox="0 0 40 40" aria-hidden="true">
                              <rect width="40" height="40" rx="20" fill={option.color} />
                              {part === 'frame' && (
                                <path
                                  d="M0 9 Q20 4 40 10 M0 17 Q20 23 40 15 M0 29 Q18 22 40 31"
                                  stroke="#fff"
                                  strokeOpacity=".18"
                                  fill="none"
                                />
                              )}
                            </svg>
                            {selection[part] === option.id && <Check size={14} />}
                          </span>
                          <span>{localized(option, locale)}</span>
                        </button>
                      ))}
                  </fieldset>
                  <p className="studio-finish-price">
                    {t('饰面加价', 'Finish upgrade')}{' '}
                    <b>+{money((part === 'seat' ? seat : frame)?.price_cents ?? 0, locale)}</b>
                  </p>
                </section>
              ))}
              <div className="studio-quantity-row">
                <label htmlFor="studio-quantity">{t('数量', 'Quantity')}</label>
                <div className="studio-quantity">
                  <button
                    disabled={quantity <= 1}
                    onClick={() => setQuantity(Math.max(1, quantity - 1))}
                    aria-label={t('减少数量', 'Decrease quantity')}
                  >
                    −
                  </button>
                  <input
                    id="studio-quantity"
                    type="number"
                    min="1"
                    max="1000"
                    step="1"
                    value={Number.isNaN(quantity) ? '' : quantity}
                    onChange={(e) =>
                      setQuantity(e.target.value === '' ? NaN : Number(e.target.value))
                    }
                  />
                  <button
                    disabled={quantity >= 1000}
                    onClick={() => setQuantity(Math.min(1000, (quantity || 0) + 1))}
                    aria-label={t('增加数量', 'Increase quantity')}
                  >
                    +
                  </button>
                </div>
              </div>
              {calculation.error && (
                <p className="studio-inline-error" role="alert">
                  {errorText(calculation.error)}
                </p>
              )}
              <div className="studio-total">
                <span>{t('配置总价', 'Your configuration')}</span>
                <strong>
                  {calculation.quote ? money(calculation.quote.total_cents, locale) : '—'}
                </strong>
              </div>
              {readOnly ? (
                <p className="studio-readonly">
                  <Layers3 size={16} />
                  {t(
                    '喜欢这个方案？使用模板后即可保存和管理询价。',
                    'Make it yours. Use this template to save designs and manage inquiries.',
                  )}
                </p>
              ) : (
                <div className="studio-actions">
                  <button
                    className="studio-primary"
                    disabled={busy || !calculation.quote}
                    onClick={() => {
                      setError('')
                      setModal('inquiry')
                    }}
                  >
                    {t('创建询价', 'Request a quote')}
                    <ArrowRight size={17} />
                  </button>
                  <button
                    className="studio-secondary"
                    disabled={busy || !calculation.quote}
                    onClick={() => {
                      setError('')
                      setModal('save')
                    }}
                  >
                    {editing ? t('保存修改', 'Save changes') : t('保存方案', 'Save design')}
                  </button>
                  {editing && (
                    <button className="studio-link" onClick={reset}>
                      {t('开始新方案', 'Start a new design')}
                    </button>
                  )}
                </div>
              )}
              <div className="studio-details">
                <span>{t('原创设计', 'Original design')}</span>
                <span>{t('固定尺寸', 'Considered proportions')}</span>
                <span>{t('按需定制', 'Made to order')}</span>
              </div>
            </aside>
          </main>
          <footer className="studio-editorial">
            <span>LESS, BUT CONSIDERED.</span>
            <p>
              {t(
                '一把好椅子，容纳日常的每一种相聚。',
                'A place for conversations, quiet mornings, and everything in between.',
              )}
            </p>
            <span>ATELIER / 001</span>
          </footer>
        </>
      )}
      {page === 'designs' && (
        <main className="studio-page">
          <div className="studio-page-heading">
            <div>
              <span className="studio-eyebrow">YOUR COLLECTION</span>
              <h1>{t('留住每一份灵感', 'Ideas worth keeping')}</h1>
              <p>
                {t(
                  '保存材质与数量，下次回来继续完善。',
                  'Your finishes, your quantities, ready when you are.',
                )}
              </p>
            </div>
            {!readOnly && (
              <button className="studio-primary" onClick={reset}>
                <Plus size={16} />
                {t('新建方案', 'New design')}
              </button>
            )}
          </div>
          <div className="studio-design-grid">
            {data.configurations.map((config) => (
              <article className="studio-design-card" key={config.id}>
                <button
                  className="studio-design-image"
                  onClick={() => reopen(config)}
                  aria-label={`${t('打开', 'Open')} ${config.name}`}
                >
                  <ChairPoster
                    seat={config.snapshot.options.find((o) => o.part === 'seat')?.color}
                    frame={config.snapshot.options.find((o) => o.part === 'frame')?.color}
                  />
                </button>
                <div className="studio-design-info">
                  <span className="studio-eyebrow">
                    ARC / {config.quantity} {t('把', 'CHAIRS')}
                  </span>
                  <h2>{config.name}</h2>
                  <p>{config.snapshot.options.map((o) => localized(o, locale)).join(' · ')}</p>
                  <div>
                    <b>{money(config.snapshot.total_cents, locale)}</b>
                    <small>{t('保存时报价', 'Saved quote')}</small>
                  </div>
                  <footer>
                    <button className="studio-link" onClick={() => reopen(config)}>
                      {t('继续配置', 'Continue design')}
                      <ArrowRight size={15} />
                    </button>
                    {!readOnly && (
                      <button
                        className="studio-icon"
                        aria-label={`${t('删除', 'Delete')} ${config.name}`}
                        onClick={() => {
                          setDeleteTarget(config)
                          setModal('delete')
                          setError('')
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </footer>
                </div>
              </article>
            ))}
          </div>
          {!data.configurations.length && (
            <div className="studio-empty">
              <Layers3 size={32} />
              <h2>{t('你的下一份灵感，从这里开始', 'Your next idea starts here')}</h2>
              <button className="studio-link" onClick={() => navigate('configure')}>
                {t('去配置一把餐椅', 'Design your chair')}
                <ArrowRight size={15} />
              </button>
            </div>
          )}
        </main>
      )}
      {page === 'inquiries' && (
        <main className="studio-page">
          <div className="studio-page-heading">
            <div>
              <span className="studio-eyebrow">FROM DESIGN TO CONVERSATION</span>
              <h1>{t('询价管理', 'The next conversation')}</h1>
              <p>
                {t(
                  '每份询价保留提交时的完整配置与报价。',
                  'Every inquiry keeps its original configuration and quote.',
                )}
              </p>
            </div>
            <span className="studio-count">
              {data.inquiries.length} {t('份询价', 'inquiries')}
            </span>
          </div>
          <div className="studio-filters">
            <label className="studio-search">
              <Search size={16} />
              <input
                aria-label={t('搜索询价', 'Search inquiries')}
                placeholder={t('搜索客户、联系方式或备注', 'Search contacts, details or notes')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <select
              aria-label={t('筛选状态', 'Filter status')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">{t('全部状态', 'All statuses')}</option>
              {inquiryStatuses.map((status) => (
                <option key={status} value={status}>
                  {statusLabels[status][locale === 'zh' ? 0 : 1]}
                </option>
              ))}
            </select>
          </div>
          <div className="studio-table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    t('客户', 'Contact'),
                    t('商品与配置', 'Configuration'),
                    t('报价', 'Quote'),
                    t('状态', 'Status'),
                    t('创建日期', 'Created'),
                    '',
                  ].map((heading) => (
                    <th key={heading}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownInquiries.map((inquiry) => (
                  <tr key={inquiry.id}>
                    <td>
                      <strong>{inquiry.contact}</strong>
                      <small>{inquiry.contact_info}</small>
                    </td>
                    <td>
                      {localized(inquiry.snapshot.product, locale)}
                      <small>
                        {inquiry.snapshot.options.map((o) => localized(o, locale)).join(' / ')} ·{' '}
                        {inquiry.snapshot.quantity}
                      </small>
                    </td>
                    <td>{money(inquiry.snapshot.total_cents, locale)}</td>
                    <td>
                      <span className={`studio-status ${inquiry.status}`}>
                        {statusLabels[inquiry.status][locale === 'zh' ? 0 : 1]}
                      </span>
                    </td>
                    <td>
                      {new Date(inquiry.created_at).toLocaleDateString(
                        locale === 'zh' ? 'zh-CN' : 'en-GB',
                      )}
                    </td>
                    <td>
                      <button className="studio-link" onClick={() => setDetail(inquiry.id)}>
                        {t('查看', 'View')}
                        <ArrowRight size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!shownInquiries.length && (
            <p className="studio-empty">{t('暂无匹配的询价。', 'No matching inquiries.')}</p>
          )}
        </main>
      )}
      {page === 'settings' && (
        <main className="studio-page">
          <div className="studio-page-heading">
            <div>
              <span className="studio-eyebrow">THE DETAILS MATTER</span>
              <h1>{t('商品设置', 'Make it your own')}</h1>
              <p>
                {t(
                  '调整商品与饰面。已提交询价的报价保持不变。',
                  'Edit the product and finishes. Existing inquiry quotes stay unchanged.',
                )}
              </p>
            </div>
            <Settings2 size={25} />
          </div>
          <ProductSettings
            key={product.id}
            product={product}
            options={options}
            locale={locale}
            readOnly={readOnly}
            busy={busy}
            execute={execute}
            onSaved={() => setNotice(t('设置已保存。', 'Settings saved.'))}
          />
        </main>
      )}
      {(modal === 'save' || modal === 'inquiry') && calculation.quote && (
        <Modal
          title={
            modal === 'save'
              ? t('保存你的方案', 'Keep your design')
              : t('创建询价', 'Start a conversation')
          }
          close={() => {
            if (!busy) setModal(null)
          }}
        >
          <form onSubmit={(event) => void submit(event)}>
            <QuoteSummary quote={calculation.quote} locale={locale} />
            {modal === 'save' ? (
              <label>
                {t('方案名称', 'Design name')}
                <input
                  name="name"
                  required
                  maxLength={160}
                  defaultValue={editing?.name ?? t('我的餐椅方案', 'My Arc design')}
                />
              </label>
            ) : (
              <>
                <label>
                  {t('联系人', 'Contact name')}
                  <input name="contact" required maxLength={160} />
                </label>
                <label>
                  {t('邮箱或电话', 'Email or phone')}
                  <input name="contactInfo" required maxLength={200} />
                </label>
                <label>
                  {t('备注', 'Notes')}
                  <textarea name="notes" maxLength={2000} rows={3} />
                </label>
                <p className="studio-muted">
                  {t(
                    '提交时将按最新商品价格确认报价。',
                    'The quote is confirmed against current pricing when submitted.',
                  )}
                </p>
              </>
            )}
            {error && (
              <p role="alert" className="studio-inline-error">
                {errorText(error)}
              </p>
            )}
            <button className="studio-primary" disabled={busy}>
              {busy && <Loader2 size={16} className="studio-spin" />}
              {modal === 'save' ? t('保存方案', 'Save design') : t('确认询价', 'Create inquiry')}
              <ArrowRight size={16} />
            </button>
          </form>
        </Modal>
      )}
      {modal === 'delete' && deleteTarget && (
        <Modal
          title={t('删除方案', 'Delete design')}
          close={() => {
            if (!busy) setModal(null)
          }}
        >
          <p>
            {t(
              `删除「${deleteTarget.name}」？已创建的询价仍会保留。`,
              `Delete “${deleteTarget.name}”? Existing inquiries will be kept.`,
            )}
          </p>
          {error && (
            <p role="alert" className="studio-inline-error">
              {errorText(error)}
            </p>
          )}
          <div className="studio-modal-actions">
            <button className="studio-secondary" disabled={busy} onClick={() => setModal(null)}>
              {t('取消', 'Cancel')}
            </button>
            <button
              className="studio-primary"
              disabled={busy}
              onClick={async () => {
                if (
                  await execute({
                    action: 'delete-configuration',
                    id: deleteTarget.id,
                  })
                ) {
                  if (editing?.id === deleteTarget.id) setEditing(null)
                  setModal(null)
                }
              }}
            >
              {t('删除方案', 'Delete design')}
            </button>
          </div>
        </Modal>
      )}
      {detailInquiry && (
        <Modal title={t('询价详情', 'Inquiry details')} close={() => setDetail(null)}>
          <InquiryDetails
            inquiry={detailInquiry}
            locale={locale}
            readOnly={readOnly}
            busy={busy}
            onStatus={async (status) => {
              await execute({
                action: 'inquiry-status',
                id: detailInquiry.id,
                status,
              })
            }}
          />
          {error && (
            <p role="alert" className="studio-inline-error">
              {errorText(error)}
            </p>
          )}
        </Modal>
      )}
    </div>
  )
}

function InquiryDetails({
  inquiry,
  locale,
  readOnly,
  busy,
  onStatus,
}: {
  inquiry: Inquiry
  locale: Locale
  readOnly: boolean
  busy: boolean
  onStatus: (status: InquiryStatus) => Promise<void>
}) {
  const t = (zh: string, en: string) => (locale === 'zh' ? zh : en)
  return (
    <>
      <QuoteSummary quote={inquiry.snapshot} locale={locale} />
      <dl className="studio-contact">
        <dt>{t('联系人', 'Contact')}</dt>
        <dd>{inquiry.contact}</dd>
        <dt>{t('联系方式', 'Email / phone')}</dt>
        <dd>{inquiry.contact_info}</dd>
        <dt>{t('备注', 'Notes')}</dt>
        <dd>{inquiry.notes || '—'}</dd>
      </dl>
      <label>
        {t('询价状态', 'Inquiry status')}
        <select
          disabled={readOnly || busy}
          value={inquiry.status}
          onChange={(e) => void onStatus(e.target.value as InquiryStatus)}
        >
          {inquiryStatuses.map((status) => (
            <option key={status} value={status}>
              {statusLabels[status][locale === 'zh' ? 0 : 1]}
            </option>
          ))}
        </select>
      </label>
      <p className="studio-muted">
        {t(
          '此报价为提交时的快照，不受后续调价影响。',
          'This quote is a snapshot from submission, unaffected by later price changes.',
        )}
      </p>
    </>
  )
}
function cents(form: FormData, field: string) {
  return Math.round(Number(form.get(field)) * 100)
}
function ProductSettings({
  product,
  options,
  locale,
  readOnly,
  busy,
  execute,
  onSaved,
}: {
  product: Product
  options: ProductOption[]
  locale: Locale
  readOnly: boolean
  busy: boolean
  execute: (command: Command) => Promise<Product3dResult | undefined>
  onSaved: () => void
}) {
  const t = (zh: string, en: string) => (locale === 'zh' ? zh : en)
  return (
    <div className="studio-settings">
      <form
        className="studio-settings-card"
        onSubmit={async (event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          const result = await execute({
            action: 'update-product',
            id: product.id,
            values: {
              name: String(form.get('name')),
              name_en: String(form.get('name_en')),
              description: String(form.get('description')),
              description_en: String(form.get('description_en')),
              price_cents: cents(form, 'price'),
            },
          })
          if (result) onSaved()
        }}
      >
        <h2>{t('商品资料', 'Product details')}</h2>
        <fieldset disabled={readOnly || busy}>
          <label>
            {t('中文名称', 'Chinese name')}
            <input name="name" defaultValue={product.name} required maxLength={160} />
          </label>
          <label>
            {t('英文名称', 'English name')}
            <input name="name_en" defaultValue={product.name_en} required maxLength={160} />
          </label>
          <label>
            {t('中文介绍', 'Chinese description')}
            <textarea
              name="description"
              defaultValue={product.description}
              rows={3}
              maxLength={2000}
            />
          </label>
          <label>
            {t('英文介绍', 'English description')}
            <textarea
              name="description_en"
              defaultValue={product.description_en}
              rows={3}
              maxLength={2000}
            />
          </label>
          <label>
            {t('基础价格（人民币元）', 'Base price (CNY)')}
            <input
              name="price"
              type="number"
              min="0"
              max="1000000"
              step="0.01"
              defaultValue={product.price_cents / 100}
              required
            />
          </label>
          {!readOnly && <button className="studio-primary">{t('保存商品', 'Save product')}</button>}
        </fieldset>
      </form>
      <div className="studio-settings-options">
        <h2>{t('材质与饰面', 'Materials & finishes')}</h2>
        {options.map((option) => (
          <form
            className="studio-settings-card"
            key={option.id}
            onSubmit={async (event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              const result = await execute({
                action: 'update-option',
                id: option.id,
                values: {
                  name: String(form.get('name')),
                  name_en: String(form.get('name_en')),
                  color: String(form.get('color')),
                  roughness: Number(form.get('roughness')),
                  price_cents: cents(form, 'price'),
                  enabled: form.get('enabled') === 'on',
                },
              })
              if (result) onSaved()
            }}
          >
            <h3>
              {localized(option, locale)}
              <span>{option.part === 'seat' ? t('椅面', 'UPHOLSTERY') : t('支架', 'FRAME')}</span>
            </h3>
            <fieldset disabled={readOnly || busy}>
              <div className="studio-form-grid">
                <label>
                  {t('中文名称', 'Chinese name')}
                  <input name="name" defaultValue={option.name} required maxLength={160} />
                </label>
                <label>
                  {t('英文名称', 'English name')}
                  <input name="name_en" defaultValue={option.name_en} required maxLength={160} />
                </label>
                <label>
                  {t('颜色', 'Color')}
                  <input name="color" type="color" defaultValue={option.color} />
                </label>
                <label>
                  {t('粗糙度（0–1）', 'Roughness (0–1)')}
                  <input
                    name="roughness"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    defaultValue={option.roughness}
                    required
                  />
                </label>
                <label>
                  {t('加价（人民币元）', 'Upgrade price (CNY)')}
                  <input
                    name="price"
                    type="number"
                    min="0"
                    max="1000000"
                    step="0.01"
                    defaultValue={option.price_cents / 100}
                    required
                  />
                </label>
                <label className="studio-check">
                  <input name="enabled" type="checkbox" defaultChecked={option.enabled} />
                  {t('可选用', 'Available')}
                </label>
              </div>
              {!readOnly && (
                <button className="studio-secondary">{t('保存饰面', 'Save finish')}</button>
              )}
            </fieldset>
          </form>
        ))}
      </div>
    </div>
  )
}
