export type Locale = 'zh' | 'en'
export type Part = 'seat' | 'frame'
export type InquiryStatus = 'new' | 'following' | 'completed' | 'cancelled'
export const inquiryStatuses: InquiryStatus[] = ['new', 'following', 'completed', 'cancelled']
export const product3dTables = [
  'products',
  'product_options',
  'configurations',
  'configuration_items',
  'inquiries',
] as const
export const MAX_PRICE_CENTS = 100_000_000
export const MAX_QUANTITY = 1000

type RecordBase = { id: string; created_at: string }
export type Product = RecordBase & {
  name: string
  name_en: string
  description: string
  description_en: string
  model: 'atelier-chair-v1'
  price_cents: number
}
export type ProductOption = RecordBase & {
  product_id: string
  part: Part
  name: string
  name_en: string
  color: string
  roughness: number
  price_cents: number
  enabled: boolean
}
export type Quote = {
  product: Pick<Product, 'id' | 'name' | 'name_en' | 'model' | 'price_cents'>
  options: ProductOption[]
  quantity: number
  unit_cents: number
  total_cents: number
  currency: 'CNY'
}
export type Configuration = RecordBase & {
  product_id: string
  name: string
  quantity: number
  snapshot: Quote
}
export type ConfigurationItem = RecordBase & {
  configuration_id: string
  option_id: string
}
export type Inquiry = RecordBase & {
  product_id: string
  contact: string
  contact_info: string
  notes: string
  status: InquiryStatus
  snapshot: Quote
}
export type Product3dData = {
  readOnly: boolean
  products: Product[]
  product_options: ProductOption[]
  configurations: Configuration[]
  configuration_items: ConfigurationItem[]
  inquiries: Inquiry[]
}
export type Selection = {
  productId: string
  optionIds: string[]
  quantity: number
}
export type Product3dCommand = { requestId: string } & (
  | ({ action: 'save-configuration'; id?: string; name: string } & Selection)
  | { action: 'delete-configuration'; id: string }
  | ({
      action: 'create-inquiry'
      contact: string
      contactInfo: string
      notes: string
    } & Selection)
  | { action: 'inquiry-status'; id: string; status: InquiryStatus }
  | {
      action: 'update-product'
      id: string
      values: Pick<Product, 'name' | 'name_en' | 'description' | 'description_en' | 'price_cents'>
    }
  | {
      action: 'update-option'
      id: string
      values: Pick<
        ProductOption,
        'name' | 'name_en' | 'color' | 'roughness' | 'price_cents' | 'enabled'
      >
    }
)
export type Product3dResult = { id: string; quote?: Quote }
export type Product3dClient = {
  read(): Promise<Product3dData>
  command(command: Product3dCommand): Promise<Product3dResult>
}

export function money(cents: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
  }).format(cents / 100)
}

export function localized(value: { name: string; name_en: string }, locale: Locale) {
  return locale === 'en' ? value.name_en || value.name : value.name
}

/** Also used on the server. Amounts are integer cents; submitted prices are never trusted. */
export function quoteProduct(
  product: Product,
  options: ProductOption[],
  selection: Selection,
): Quote {
  if (product.id !== selection.productId) throw new Error('record_unavailable')
  if (
    !Number.isInteger(selection.quantity) ||
    selection.quantity < 1 ||
    selection.quantity > MAX_QUANTITY
  )
    throw new Error('invalid_quantity')
  if (selection.optionIds.length !== 2 || new Set(selection.optionIds).size !== 2)
    throw new Error('invalid_options')
  const selected = selection.optionIds.map((id) => options.find((option) => option.id === id))
  if (selected.some((option) => !option || option.product_id !== product.id || !option.enabled))
    throw new Error('option_unavailable')
  const chosen = selected as ProductOption[]
  if (
    chosen.filter((option) => option.part === 'seat').length !== 1 ||
    chosen.filter((option) => option.part === 'frame').length !== 1
  )
    throw new Error('invalid_options')
  const amounts = [product.price_cents, ...chosen.map((option) => option.price_cents)]
  if (
    amounts.some(
      (amount) => !Number.isSafeInteger(amount) || amount < 0 || amount > MAX_PRICE_CENTS,
    )
  )
    throw new Error('invalid_price')
  const unit_cents = amounts.reduce((sum, amount) => sum + amount, 0)
  return {
    product: {
      id: product.id,
      name: product.name,
      name_en: product.name_en,
      model: product.model,
      price_cents: product.price_cents,
    },
    options: chosen.map((option) => Object.assign({}, option)),
    quantity: selection.quantity,
    unit_cents,
    total_cents: unit_cents * selection.quantity,
    currency: 'CNY',
  }
}
