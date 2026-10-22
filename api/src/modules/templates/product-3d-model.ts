import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import type { IR, Field } from '@lovbase/core/ir'
import { irToDDL, qi } from '@lovbase/core/ddl'
import { quoteProduct, type Product, type ProductOption } from '@lovbase/core/product-3d'

type Definition = [string, string, Array<[string, Field['type'], string?]>]
const definitions: Definition[] = [
  [
    'products',
    '商品',
    [
      ['name', 'text'],
      ['name_en', 'text'],
      ['description', 'text'],
      ['description_en', 'text'],
      ['model', 'text'],
      ['price_cents', 'number'],
    ],
  ],
  [
    'product_options',
    '配置选项',
    [
      ['product_id', 'link', 'products'],
      ['part', 'select', 'seat,frame'],
      ['name', 'text'],
      ['name_en', 'text'],
      ['color', 'text'],
      ['roughness', 'number'],
      ['price_cents', 'number'],
      ['enabled', 'boolean'],
    ],
  ],
  [
    'configurations',
    '配置方案',
    [
      ['product_id', 'link', 'products'],
      ['name', 'text'],
      ['quantity', 'number'],
      ['snapshot', 'text'],
    ],
  ],
  [
    'configuration_items',
    '方案选项',
    [
      ['configuration_id', 'link', 'configurations'],
      ['option_id', 'link', 'product_options'],
    ],
  ],
  [
    'inquiries',
    '询价单',
    [
      ['product_id', 'link', 'products'],
      ['contact', 'text'],
      ['contact_info', 'text'],
      ['notes', 'text'],
      ['status', 'select', 'new,following,completed,cancelled'],
      ['snapshot', 'text'],
    ],
  ],
]
export const product3dIR: IR = {
  version: 1,
  appName: '3D Product Studio',
  entities: definitions.map(([dbName, name, fields]) => ({
    id: dbName,
    dbName,
    name,
    fields: fields.map(([field, type, extra]) => ({
      id: `${dbName}_${field}`,
      dbName: field,
      name: field,
      type,
      required: false,
      ...(type === 'link' ? { linkTo: extra } : {}),
      ...(type === 'select' ? { options: extra!.split(',') } : {}),
    })),
  })),
}
export async function installProduct3d(c: pg.PoolClient, schema: string) {
  await c.query(irToDDL(product3dIR, schema))
  const table = (name: string) => `${qi(schema)}.${qi(name)}`
  await c.query(
    `ALTER TABLE ${table('products')} ADD CHECK(price_cents >= 0 AND price_cents <= 100000000 AND price_cents = trunc(price_cents))`,
  )
  await c.query(`ALTER TABLE ${table('product_options')}
    ADD CHECK(part IN ('seat','frame')),
    ADD CHECK(price_cents >= 0 AND price_cents <= 100000000 AND price_cents = trunc(price_cents)),
    ADD CHECK(roughness BETWEEN 0 AND 1),
    ADD CHECK(color ~ '^#[0-9A-Fa-f]{6}$')`)
  await c.query(
    `ALTER TABLE ${table('configurations')} ADD CHECK(quantity BETWEEN 1 AND 1000 AND quantity=trunc(quantity))`,
  )
  await c.query(
    `ALTER TABLE ${table('configuration_items')} ADD UNIQUE(configuration_id,option_id)`,
  )
  await c.query(
    `ALTER TABLE ${table('inquiries')} ADD CHECK(status IN ('new','following','completed','cancelled'))`,
  )
}
export async function seedProduct3d(c: pg.PoolClient, schema: string) {
  const insert = async (table: string, row: Record<string, unknown>) => {
    const entries = Object.entries(row)
    await c.query(
      `INSERT INTO ${qi(schema)}.${qi(table)} (${entries.map(([key]) => qi(key)).join(',')}) VALUES (${entries.map((_, i) => '$' + (i + 1)).join(',')})`,
      entries.map(([, value]) => value),
    )
  }
  const product: Product = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    name: '弧 · 餐椅',
    name_en: 'Arc dining chair',
    description: '弧形靠背，温润实木与柔软织物。为日常相聚，留一个舒服的位置。',
    description_en:
      'A curved back, warm timber and soft upholstery. A considered place for everyday gatherings.',
    model: 'atelier-chair-v1',
    price_cents: 168000,
  }
  await insert('products', product)
  const specs: Array<[ProductOption['part'], string, string, string, number, number]> = [
    ['seat', '燕麦白', 'Oat', '#d8cdb8', 0.92, 0],
    ['seat', '苔藓绿', 'Moss', '#687262', 0.9, 12000],
    ['seat', '陶土红', 'Clay', '#ae7059', 0.9, 12000],
    ['seat', '石墨灰', 'Graphite', '#454847', 0.88, 8000],
    ['frame', '天然橡木', 'Natural oak', '#b88b58', 0.5, 0],
    ['frame', '深色胡桃木', 'Walnut', '#684632', 0.46, 24000],
    ['frame', '烟熏橡木', 'Smoked oak', '#3e3932', 0.55, 18000],
  ]
  const options: ProductOption[] = specs.map(
    ([part, name, name_en, color, roughness, price_cents]) => ({
      id: randomUUID(),
      created_at: product.created_at,
      product_id: product.id,
      part,
      name,
      name_en,
      color,
      roughness,
      price_cents,
      enabled: true,
    }),
  )
  for (const option of options) await insert('product_options', option)
  for (const [index, name] of [
    '餐厅灵感 / Dining room',
    '工作室会客区 / Studio lounge',
  ].entries()) {
    const id = randomUUID()
    const selected = [options[index], options[4 + index]]
    const quote = quoteProduct(product, options, {
      productId: product.id,
      optionIds: selected.map((o) => o.id),
      quantity: index ? 6 : 2,
    })
    await insert('configurations', {
      id,
      product_id: product.id,
      name,
      quantity: quote.quantity,
      snapshot: JSON.stringify(quote),
    })
    for (const option of selected)
      await insert('configuration_items', {
        id: randomUUID(),
        configuration_id: id,
        option_id: option.id,
      })
    await insert('inquiries', {
      id: randomUUID(),
      product_id: product.id,
      contact: index ? '示例工作室 / Sample Studio' : '示例客户 / Sample Customer',
      contact_info: `sample${index + 1}@example.invalid`,
      notes: '虚构演示数据 / Fictional sample inquiry',
      status: index ? 'following' : 'new',
      snapshot: JSON.stringify(quote),
    })
  }
}
