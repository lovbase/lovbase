import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { listedTemplates, type Template } from '@lovbase/core/templates'
import type { Locale } from './i18n'
import { localeFromCookie, localeFromValue } from './i18n'

export type SeoPage = 'home' | 'pricing' | 'templates'

const serverRequest = createIsomorphicFn()
  .client(() => null)
  .server(() => getRequest())

type SeoCopy = { title: string; description: string }

const COPY: Record<SeoPage, Record<Locale, SeoCopy>> = {
  home: {
    en: {
      title: 'Lovbase · Build real apps on Postgres',
      description:
        'Describe an app in plain language. Lovbase designs a real Postgres database and Boris writes the interface.',
    },
    zh: {
      title: 'Lovbase · 用 AI 构建真实应用',
      description: '用自然语言描述应用，Lovbase 设计真实的 Postgres 数据库，Boris 编写可运行的界面。',
    },
  },
  pricing: {
    en: {
      title: 'Pricing · Lovbase',
      description:
        'Priced per usage, not per seat. The free plan already builds a real Postgres database; self-hosting is always free.',
    },
    zh: {
      title: '价格 · Lovbase',
      description: '按实际用量计费，不按座位收费。免费版即可构建真实的 Postgres 数据库，自托管始终免费。',
    },
  },
  templates: {
    en: {
      title: 'Templates · Lovbase',
      description:
        'Start with a ready-made Lovbase app template, then make it your own with a real Postgres database.',
    },
    zh: {
      title: '应用模板 · Lovbase',
      description: '从 Lovbase 应用模板开始，连接真实的 Postgres 数据库，再按你的需求继续修改。',
    },
  },
}

const PATHS: Record<SeoPage, string> = {
  home: '/',
  pricing: '/pricing',
  templates: '/templates',
}

/** Every built-in template has a page of its own, so each one can be linked, shared and indexed. */
export const templatePath = (id: string) => `/templates/${id}`

/** Social cards cannot show an SVG, so a vector cover falls back to the site image. */
export function templateImage(template: Pick<Template, 'cover'>): string {
  return /\.(png|jpe?g|webp)$/i.test(template.cover) ? template.cover : '/og-image.png'
}

export function templateCopy(template: Template, locale: Locale): SeoCopy {
  return locale === 'zh'
    ? {
        title: `${template.name.zh} · Lovbase 应用模板`,
        description: `${template.description.zh} 免费的 Lovbase 应用模板，自带真实的 Postgres 数据库与示例数据。`,
      }
    : {
        title: `${template.name.en} · Lovbase templates`,
        description: `${template.description.en} A free Lovbase template with its own Postgres database and sample data.`,
      }
}

function requestLocale(): Locale {
  if (typeof window !== 'undefined') {
    return localeFromUrl(new URL(window.location.href), document.cookie, null)
  }
  try {
    const request = serverRequest()
    if (!request) return 'en'
    return localeFromUrl(
      new URL(request.url),
      request.headers.get('cookie'),
      request.headers.get('accept-language'),
    )
  } catch {
    return 'en'
  }
}

function explicitRequestLocale(): Locale | null {
  try {
    const url = typeof window !== 'undefined' ? new URL(window.location.href) : new URL(serverRequest()!.url)
    return localeFromValue(url.searchParams.get('lang'))
  } catch {
    return null
  }
}

export function localeFromUrl(
  url: URL | string,
  cookie: string | null = null,
  acceptLanguage: string | null = null,
): Locale {
  const parsed = typeof url === 'string' ? new URL(url) : url
  return localeFromValue(parsed.searchParams.get('lang')) ?? localeLocaleFromHeaders(cookie, acceptLanguage)
}

function localeLocaleFromHeaders(cookie: string | null, acceptLanguage: string | null): Locale {
  return localeFromCookie(cookie) ?? ((acceptLanguage ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en')
}

function requestOrigin(): string {
  if (typeof window !== 'undefined') return window.location.origin
  try {
    return new URL(serverRequest()!.url).origin
  } catch {
    return 'http://localhost:3008'
  }
}

export function canonicalUrl(path: string, locale: Locale, origin = requestOrigin()): string {
  const url = new URL(path, origin)
  if (locale === 'zh') url.searchParams.set('lang', 'zh')
  else url.searchParams.delete('lang')
  return url.href
}

/**
 * What the structured data of a page is built from: the language it is rendered in, the language
 * its URLs are canonical for (English unless `?lang=zh` is explicit) and the site origin.
 */
type GraphContext = { locale: Locale; urlLocale: Locale; origin: string }

function siteGraph({ locale, urlLocale, origin }: GraphContext) {
  const url = canonicalUrl('/', urlLocale, origin)
  return [
    { '@type': 'WebSite', name: 'Lovbase', url, inLanguage: locale === 'zh' ? 'zh-CN' : 'en' },
    {
      '@type': 'SoftwareApplication',
      name: 'Lovbase',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      url,
      description: COPY.home[locale].description,
    },
  ]
}

/** The gallery as a list, so a search engine knows the pages below it belong together. */
export function templateListGraph({ locale, urlLocale, origin }: GraphContext) {
  return [
    {
      '@type': 'ItemList',
      name: COPY.templates[locale].title,
      itemListElement: listedTemplates.map((template, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: template.name[locale],
        url: canonicalUrl(templatePath(template.id), urlLocale, origin),
      })),
    },
  ]
}

export function templateGraph(template: Template, { locale, urlLocale, origin }: GraphContext) {
  const page = canonicalUrl(templatePath(template.id), urlLocale, origin)
  return [
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Lovbase', item: canonicalUrl('/', urlLocale, origin) },
        {
          '@type': 'ListItem',
          position: 2,
          name: locale === 'zh' ? '应用模板' : 'Templates',
          item: canonicalUrl('/templates', urlLocale, origin),
        },
        { '@type': 'ListItem', position: 3, name: template.name[locale], item: page },
      ],
    },
    {
      '@type': 'SoftwareApplication',
      name: template.name[locale],
      description: template.description[locale],
      url: page,
      image: new URL(templateImage(template), origin).href,
      applicationCategory: template.categoryId === 'games' ? 'GameApplication' : 'BusinessApplication',
      operatingSystem: 'Web',
      // Every template can be remixed on the free plan.
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
  ]
}

type HeadInput = {
  path: string
  copy: (locale: Locale) => SeoCopy
  /** Site-relative image for the social card. */
  image?: string
  graph?: (context: GraphContext) => object[]
}

function headFor({ path, copy, image = '/og-image.png', graph }: HeadInput) {
  const locale = requestLocale()
  const urlLocale = explicitRequestLocale() ?? 'en'
  const origin = requestOrigin()
  const text = copy(locale)
  const canonical = canonicalUrl(path, urlLocale, origin)
  const english = canonicalUrl(path, 'en', origin)
  const chinese = canonicalUrl(path, 'zh', origin)
  const imageUrl = new URL(image, origin).href
  const localeTag = locale === 'zh' ? 'zh_CN' : 'en_US'
  const alternateLocale = locale === 'zh' ? 'en_US' : 'zh_CN'
  const nodes = graph?.({ locale, urlLocale, origin })

  return {
    meta: [
      { title: text.title },
      { name: 'description', content: text.description },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Lovbase' },
      { property: 'og:locale', content: localeTag },
      { property: 'og:locale:alternate', content: alternateLocale },
      { property: 'og:title', content: text.title },
      { property: 'og:description', content: text.description },
      { property: 'og:url', content: canonical },
      { property: 'og:image', content: imageUrl },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: text.title },
      { name: 'twitter:description', content: text.description },
      { name: 'twitter:image', content: imageUrl },
    ],
    links: [
      { rel: 'canonical', href: canonical },
      { rel: 'alternate', hrefLang: 'en', href: english },
      { rel: 'alternate', hrefLang: 'zh-CN', href: chinese },
      { rel: 'alternate', hrefLang: 'x-default', href: english },
    ],
    scripts: nodes
      ? [
          {
            type: 'application/ld+json',
            children: JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes }),
          },
        ]
      : undefined,
  }
}

const PAGE_GRAPHS: Partial<Record<SeoPage, (context: GraphContext) => object[]>> = {
  home: siteGraph,
  templates: templateListGraph,
}

export function seoHead(page: SeoPage) {
  return headFor({ path: PATHS[page], copy: (locale) => COPY[page][locale], graph: PAGE_GRAPHS[page] })
}

export function templateHead(template: Template) {
  return headFor({
    path: templatePath(template.id),
    copy: (locale) => templateCopy(template, locale),
    image: templateImage(template),
    graph: (context) => templateGraph(template, context),
  })
}

export function seoNoIndex(title: string) {
  return { meta: [{ title }, { name: 'robots', content: 'noindex,nofollow' }] }
}

export function publicSitemapPaths(origin: string): string[] {
  const paths = [...Object.values(PATHS), ...listedTemplates.map((template) => templatePath(template.id))]
  return paths.flatMap((path) => [canonicalUrl(path, 'en', origin), canonicalUrl(path, 'zh', origin)])
}
