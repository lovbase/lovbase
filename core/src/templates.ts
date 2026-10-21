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
] as const

export function templateById(id: string) {
  return templates.find((template) => template.id === id)
}
