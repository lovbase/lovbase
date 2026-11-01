export type TemplateLocale = 'zh' | 'en'
export type Localized = Record<TemplateLocale, string>

export const templates = [
  {
    id: 'inkwave',
    version: 1,
    name: { zh: 'INKWAVE 墨浪对战', en: 'INKWAVE · Turf War' },
    description: {
      zh: '在浏览器中涂墨争地，打造属于你的 3D 对战游戏。',
      en: 'Paint the arena and make this 3D browser game your own.',
    },
    categoryId: 'games',
    category: { zh: '游戏与互动', en: 'Games & Interactive' },
    cover: '/templates/inkwave.jpg',
  },
  {
    id: 'inventory',
    version: 1,
    name: { zh: '库存与采购管理', en: 'Inventory & Purchasing' },
    description: {
      zh: '从入库到采购，让每一件库存都有迹可循。',
      en: 'Every item accounted for. From receiving to replenishment.',
    },
    categoryId: 'operations',
    category: { zh: '运营管理', en: 'Operations' },
    cover: '/templates/inventory.jpg',
  },
  {
    id: 'product-3d',
    version: 1,
    name: { zh: '三维商品配置与报价', en: '3D Product Studio' },
    description: {
      zh: '从一把椅子的灵感，到一份真实的报价。',
      en: 'From a considered chair to a quote that means business.',
    },
    categoryId: 'commerce',
    category: { zh: '商品与销售', en: 'Commerce' },
    cover: '/templates/product-3d.svg',
  },
] as const

export function templateById(id: string) {
  return templates.find((template) => template.id === id)
}

export type TemplateId = (typeof templates)[number]['id']
