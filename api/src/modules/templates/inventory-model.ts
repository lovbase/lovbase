import type { IR, Field } from '@lovbase/core/ir'
import { irToDDL, qi } from '@lovbase/core/ddl'
import type pg from 'pg'
import { randomUUID } from 'node:crypto'

const text = (name: string): [string, Field['type']] => [name, 'text']
const number = (name: string): [string, Field['type']] => [name, 'number']
const link = (name: string, target: string): [string, Field['type'], string] => [name, 'link', target]
const definitions: [string, string, [string, Field['type'], string?][]][] = [
  ['categories', '分类', [text('name'), text('name_en')]],
  [
    'suppliers',
    '供应商',
    [
      text('name'),
      text('name_en'),
      text('contact'),
      text('email'),
      text('phone'),
      number('lead_days'),
      ['archived', 'boolean'],
    ],
  ],
  [
    'locations',
    '库位',
    [text('name'), text('name_en'), link('parent_id', 'locations'), ['archived', 'boolean']],
  ],
  [
    'products',
    '商品',
    [
      text('name'),
      text('name_en'),
      text('sku'),
      text('description'),
      text('unit'),
      link('category_id', 'categories'),
      link('supplier_id', 'suppliers'),
      number('cost'),
      number('price'),
      number('reorder_point'),
      number('reorder_quantity'),
      ['archived', 'boolean'],
    ],
  ],
  [
    'balances',
    '库位库存',
    [link('product_id', 'products'), link('location_id', 'locations'), number('quantity')],
  ],
  [
    'orders',
    '采购单',
    [
      text('number'),
      link('supplier_id', 'suppliers'),
      text('status'),
      ['expected_at', 'date'],
      text('notes'),
    ],
  ],
  [
    'order_items',
    '采购明细',
    [
      link('order_id', 'orders'),
      link('product_id', 'products'),
      link('location_id', 'locations'),
      number('quantity'),
      number('received'),
      number('cost'),
    ],
  ],
  [
    'movements',
    '库存流水',
    [
      link('product_id', 'products'),
      link('location_id', 'locations'),
      link('destination_id', 'locations'),
      link('order_id', 'orders'),
      text('kind'),
      number('quantity'),
      text('note'),
    ],
  ],
]
export const inventoryIR: IR = {
  version: 1,
  appName: 'Inventory & Purchasing',
  entities: definitions.map(([dbName, name, fields]) => ({
    id: dbName,
    name,
    dbName,
    fields: fields.map(([field, type, target]) => ({
      id: `${dbName}_${field}`,
      name: field,
      dbName: field,
      type,
      required: false,
      ...(target ? { linkTo: target } : {}),
    })),
  })),
}

export async function installInventory(c: pg.PoolClient, schema: string) {
  // Trusted, versioned model; schema never comes from a browser-supplied identifier.
  await c.query(irToDDL(inventoryIR, schema))
  const table = (name: string) => `${qi(schema)}.${qi(name)}`
  await c.query(`ALTER TABLE ${table('products')} ADD UNIQUE(sku), ALTER COLUMN sku SET NOT NULL`)
  await c.query(
    `ALTER TABLE ${table('balances')} ADD UNIQUE(product_id,location_id), ALTER COLUMN product_id SET NOT NULL, ALTER COLUMN location_id SET NOT NULL, ALTER COLUMN quantity SET NOT NULL, ADD CHECK(quantity >= 0)`,
  )
  await c.query(
    `ALTER TABLE ${table('orders')} ADD UNIQUE(number), ADD CHECK(status IN ('draft','submitted','partial','received','cancelled'))`,
  )
  await c.query(
    `ALTER TABLE ${table('order_items')} ADD CHECK(quantity > 0 AND received >= 0 AND received <= quantity AND cost >= 0)`,
  )
  await c.query(
    `ALTER TABLE ${table('products')} ADD CHECK(cost >= 0 AND price >= 0 AND reorder_point >= 0 AND reorder_quantity >= 0)`,
  )
  await c.query(`CREATE INDEX ON ${table('movements')}(product_id,created_at)`)
}

export async function seedInventory(c: pg.PoolClient, schema: string, now = new Date()) {
  const insert = async (table: string, values: Record<string, unknown>, at = now) => {
    const row = { id: randomUUID(), created_at: at.toISOString(), ...values }
    const columns = Object.keys(row)
    await c.query(
      `INSERT INTO ${qi(schema)}.${qi(table)} (${columns.map(qi).join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})`,
      Object.values(row),
    )
    return row.id
  }
  const categories: string[] = []
  for (const [name, name_en] of [
    ['办公用品', 'Office'],
    ['电子设备', 'Electronics'],
    ['清洁用品', 'Cleaning'],
  ]) {
    categories.push(await insert('categories', { name, name_en }))
  }
  const suppliers: string[] = []
  for (const [i, [name, name_en]] of [
    ['青禾商贸', 'Greenfield Supply'],
    ['星桥科技', 'Starbridge Tech'],
    ['洁源用品', 'Clearwater Goods'],
    ['北岸工业', 'Northshore Industrial'],
  ].entries()) {
    suppliers.push(
      await insert('suppliers', {
        name,
        name_en,
        contact: 'Demo',
        email: `supplier${i + 1}@example.invalid`,
        phone: '—',
        lead_days: i + 3,
        archived: false,
      }),
    )
  }
  const warehouse = await insert('locations', {
    name: '中央仓库',
    name_en: 'Central warehouse',
    archived: false,
  })
  const locations = [
    await insert('locations', {
      name: 'A 区货架',
      name_en: 'Zone A shelves',
      parent_id: warehouse,
      archived: false,
    }),
    await insert('locations', {
      name: 'B 区货架',
      name_en: 'Zone B shelves',
      parent_id: warehouse,
      archived: false,
    }),
    await insert('locations', { name: '城市门店', name_en: 'City store', archived: false }),
  ]
  const names = [
    ['再生纸笔记本', 'Recycled notebook'],
    ['桌面收纳盒', 'Desk tray'],
    ['中性笔套装', 'Gel pens'],
    ['A4 打印纸', 'A4 paper'],
    ['便签本', 'Sticky notes'],
    ['文件夹', 'Document folder'],
    ['订书机', 'Stapler'],
    ['白板笔', 'Whiteboard markers'],
    ['长尾夹', 'Binder clips'],
    ['标签纸', 'Label sheets'],
    ['无线键盘', 'Wireless keyboard'],
    ['人体工学鼠标', 'Ergonomic mouse'],
    ['USB 扩展坞', 'USB hub'],
    ['显示器支架', 'Monitor stand'],
    ['充电线', 'Charging cable'],
    ['桌面台灯', 'Task light'],
    ['移动电源', 'Power bank'],
    ['会议耳机', 'Meeting headset'],
    ['网络摄像头', 'Webcam'],
    ['电源插座', 'Power strip'],
    ['超细纤维抹布', 'Microfiber cloth'],
    ['洗手液', 'Hand soap'],
    ['垃圾袋', 'Waste bags'],
    ['清洁喷雾', 'Cleaning spray'],
    ['一次性手套', 'Disposable gloves'],
    ['清洁海绵', 'Cleaning sponge'],
    ['地板清洁剂', 'Floor cleaner'],
    ['纸巾', 'Paper towels'],
    ['玻璃清洁剂', 'Glass cleaner'],
    ['拖把替换头', 'Mop refill'],
  ]
  const products: string[] = []
  for (const [i, [name, name_en]] of names.entries()) {
    const cost = 8 + ((i * 17) % 140)
    const id = await insert('products', {
      name,
      name_en,
      sku: `LB-${1001 + i}`,
      description: '',
      unit: 'each',
      category_id: categories[Math.floor(i / 10)],
      supplier_id: suppliers[i % 4],
      cost,
      price: cost * 1.5,
      reorder_point: 10,
      reorder_quantity: 20,
      archived: false,
    })
    products.push(id)
    const location = locations[i % 3]
    const quantity = i % 6 === 0 ? 0 : i % 3 === 0 ? 6 : 35 + i
    await insert('balances', { product_id: id, location_id: location, quantity })
    await insert(
      'movements',
      {
        product_id: id,
        location_id: location,
        kind: 'received',
        quantity: quantity + 12,
        note: 'Opening stock / 期初库存',
      },
      new Date(now.getTime() - 32 * 86400000),
    )
    for (let j = 0; j < 3; j++)
      await insert(
        'movements',
        {
          product_id: id,
          location_id: location,
          kind: 'shipped',
          quantity: 4,
          note: 'Sample order / 示例订单',
        },
        new Date(now.getTime() - (2 + j * 8 + (i % 4)) * 86400000),
      )
  }
  for (const [i, status] of ['draft', 'submitted', 'partial', 'received', 'cancelled'].entries()) {
    const order = await insert('orders', {
      number: `PO-${now.getFullYear()}-${String(i + 1).padStart(3, '0')}`,
      supplier_id: suppliers[i % 4],
      status,
      expected_at: new Date(now.getTime() + (i - 2) * 86400000).toISOString(),
      notes: 'Sample purchase / 示例采购',
    })
    const productIndex = i % 4
    const received = status === 'received' ? 20 : status === 'partial' ? 8 : 0
    await insert('order_items', {
      order_id: order,
      product_id: products[productIndex],
      location_id: locations[productIndex % 3],
      quantity: 20,
      received,
      cost: 8 + ((productIndex * 17) % 140),
    })
    if (received) {
      await c.query(`UPDATE ${qi(schema)}.balances SET quantity = quantity + $1 WHERE product_id=$2`, [
        received,
        products[productIndex],
      ])
      await insert('movements', {
        product_id: products[productIndex],
        location_id: locations[productIndex % 3],
        order_id: order,
        kind: 'received',
        quantity: received,
        note: 'Purchase receipt / 采购收货',
      })
    }
  }
}
