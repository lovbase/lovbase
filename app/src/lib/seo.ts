import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
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

export function seoHead(page: SeoPage) {
  const locale = requestLocale()
  const canonicalLocale = explicitRequestLocale() ?? 'en'
  const copy = COPY[page][locale]
  const path = PATHS[page]
  const canonical = canonicalUrl(path, canonicalLocale)
  const english = canonicalUrl(path, 'en')
  const chinese = canonicalUrl(path, 'zh')
  const image = new URL('/og-image.png', requestOrigin()).href
  const localeTag = locale === 'zh' ? 'zh_CN' : 'en_US'
  const alternateLocale = locale === 'zh' ? 'en_US' : 'zh_CN'

  return {
    meta: [
      { title: copy.title },
      { name: 'description', content: copy.description },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Lovbase' },
      { property: 'og:locale', content: localeTag },
      { property: 'og:locale:alternate', content: alternateLocale },
      { property: 'og:title', content: copy.title },
      { property: 'og:description', content: copy.description },
      { property: 'og:url', content: canonical },
      { property: 'og:image', content: image },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: copy.title },
      { name: 'twitter:description', content: copy.description },
      { name: 'twitter:image', content: image },
    ],
    links: [
      { rel: 'canonical', href: canonical },
      { rel: 'alternate', hrefLang: 'en', href: english },
      { rel: 'alternate', hrefLang: 'zh-CN', href: chinese },
      { rel: 'alternate', hrefLang: 'x-default', href: english },
    ],
    scripts:
      page === 'home'
        ? [
            {
              type: 'application/ld+json',
              children: JSON.stringify({
                '@context': 'https://schema.org',
                '@graph': [
                  {
                    '@type': 'WebSite',
                    name: 'Lovbase',
                    url: english,
                    inLanguage: locale === 'zh' ? 'zh-CN' : 'en',
                  },
                  {
                    '@type': 'SoftwareApplication',
                    name: 'Lovbase',
                    applicationCategory: 'BusinessApplication',
                    operatingSystem: 'Web',
                    url: english,
                    description: copy.description,
                  },
                ],
              }),
            },
          ]
        : undefined,
  }
}

export function seoNoIndex(title: string) {
  return { meta: [{ title }, { name: 'robots', content: 'noindex,nofollow' }] }
}

export function publicSitemapPaths(origin: string): string[] {
  return (Object.values(PATHS) as string[]).flatMap((path) => [
    canonicalUrl(path, 'en', origin),
    canonicalUrl(path, 'zh', origin),
  ])
}
