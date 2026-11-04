import { describe, expect, test } from 'bun:test'
import { listedTemplates, templateById, templates } from '@lovbase/core/templates'
import {
  canonicalUrl,
  localeFromUrl,
  publicSitemapPaths,
  templateCopy,
  templateGraph,
  templateImage,
  templateListGraph,
  templatePath,
} from '../src/lib/seo'

const origin = 'https://lovbase.dev'
const crm = templateById('crm')!
const inventory = templateById('inventory')!

describe('localeFromUrl', () => {
  test('the explicit lang query wins over cookie and browser preference', () => {
    expect(localeFromUrl('https://lovbase.dev/?lang=zh', 'lovbase_locale=en', 'en-US')).toBe('zh')
    expect(localeFromUrl('https://lovbase.dev/?lang=en', 'lovbase_locale=zh', 'zh-CN')).toBe('en')
  })

  test('falls back to cookie, then Accept-Language, then English', () => {
    expect(localeFromUrl('https://lovbase.dev/', 'lovbase_locale=zh', 'en-US')).toBe('zh')
    expect(localeFromUrl('https://lovbase.dev/', null, 'zh-CN')).toBe('zh')
    expect(localeFromUrl('https://lovbase.dev/', null, 'en-US')).toBe('en')
  })
})

describe('canonicalUrl', () => {
  test('omits the default English query and keeps the Chinese query', () => {
    expect(canonicalUrl('/pricing', 'en', origin)).toBe('https://lovbase.dev/pricing')
    expect(canonicalUrl('/pricing', 'zh', origin)).toBe('https://lovbase.dev/pricing?lang=zh')
  })
})

describe('publicSitemapPaths', () => {
  test('lists the bilingual public pages, then a page per built-in template', () => {
    const urls = publicSitemapPaths(origin)
    expect(urls.slice(0, 6)).toEqual([
      'https://lovbase.dev/',
      'https://lovbase.dev/?lang=zh',
      'https://lovbase.dev/pricing',
      'https://lovbase.dev/pricing?lang=zh',
      'https://lovbase.dev/templates',
      'https://lovbase.dev/templates?lang=zh',
    ])
    expect(urls).toHaveLength(6 + listedTemplates.length * 2)
    expect(urls).not.toContain('https://lovbase.dev/templates/inkwave')
    expect(urls).toContain('https://lovbase.dev/templates/crm')
    expect(urls).toContain('https://lovbase.dev/templates/crm?lang=zh')
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe('template pages', () => {
  test('each template has its own path, title and description in both languages', () => {
    expect(templatePath('crm')).toBe('/templates/crm')
    expect(templateCopy(crm, 'en').title).toBe('Sales Pipeline CRM · Lovbase templates')
    expect(templateCopy(crm, 'en').description).toStartWith(crm.description.en)
    expect(templateCopy(crm, 'zh').title).toBe('客户与销售管道 · Lovbase 应用模板')
    expect(templateCopy(crm, 'zh').description).toStartWith(crm.description.zh)
  })

  test('every template fits a search snippet in both languages and has three highlights', () => {
    for (const template of templates) {
      for (const locale of ['en', 'zh'] as const) {
        const copy = templateCopy(template, locale)
        expect(copy.title).toContain(template.name[locale])
        expect(copy.title).toContain('Lovbase')
        expect(copy.description.length).toBeLessThanOrEqual(160)
        expect(template.highlights[locale]).toHaveLength(3)
      }
    }
  })

  test('a vector cover falls back to the site image for social cards', () => {
    expect(templateImage(inventory)).toBe('/templates/inventory.jpg')
    expect(templateImage(crm)).toBe('/og-image.png')
  })

  test('breadcrumbs and the application node point at the canonical page', () => {
    const [crumbs, app] = templateGraph(crm, { locale: 'zh', urlLocale: 'zh', origin }) as [
      { itemListElement: { name: string; item: string }[] },
      { url: string; image: string; applicationCategory: string },
    ]
    expect(crumbs.itemListElement.map((c) => c.item)).toEqual([
      'https://lovbase.dev/?lang=zh',
      'https://lovbase.dev/templates?lang=zh',
      'https://lovbase.dev/templates/crm?lang=zh',
    ])
    expect(crumbs.itemListElement[2].name).toBe(crm.name.zh)
    expect(app.url).toBe('https://lovbase.dev/templates/crm?lang=zh')
    expect(app.image).toBe('https://lovbase.dev/og-image.png')
    expect(app.applicationCategory).toBe('BusinessApplication')
    const [, game] = templateGraph(templateById('inkwave')!, { locale: 'en', urlLocale: 'en', origin }) as [
      unknown,
      { applicationCategory: string },
    ]
    expect(game.applicationCategory).toBe('GameApplication')
  })

  test('the gallery page lists every template page in order', () => {
    const [list] = templateListGraph({ locale: 'en', urlLocale: 'en', origin }) as [
      { itemListElement: { position: number; name: string; url: string }[] },
    ]
    expect(list.itemListElement).toHaveLength(listedTemplates.length)
    expect(list.itemListElement[0]).toEqual({
      '@type': 'ListItem',
      position: 1,
      name: listedTemplates[0].name.en,
      url: `https://lovbase.dev/templates/${listedTemplates[0].id}`,
    })
  })
})
