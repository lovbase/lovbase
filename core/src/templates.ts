export type TemplateLocale = 'zh' | 'en'
export type Localized = Record<TemplateLocale, string>

export const templates = [
  {
    id: 'inventory',
    version: 1,
    name: { zh: '库存与采购管理', en: 'Inventory & Purchasing' },
    description: {
      zh: '从入库到采购，让每一件库存都有迹可循。',
      en: 'Every item accounted for. From receiving to replenishment.',
    },
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
    category: { zh: '商品与销售', en: 'Commerce' },
    cover: '/templates/product-3d.svg',
  },
] as const

export function templateById(id: string) {
  return templates.find((template) => template.id === id)
}

export type TemplateId = (typeof templates)[number]['id']
