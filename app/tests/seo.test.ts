import { describe, expect, test } from 'bun:test'
import { canonicalUrl, localeFromUrl, publicSitemapPaths } from '../src/lib/seo'

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
    expect(canonicalUrl('/pricing', 'en', 'https://lovbase.dev')).toBe('https://lovbase.dev/pricing')
    expect(canonicalUrl('/pricing', 'zh', 'https://lovbase.dev')).toBe('https://lovbase.dev/pricing?lang=zh')
  })
})

describe('publicSitemapPaths', () => {
  test('contains only the bilingual public pages', () => {
    expect(publicSitemapPaths('https://lovbase.dev')).toEqual([
      'https://lovbase.dev/',
      'https://lovbase.dev/?lang=zh',
      'https://lovbase.dev/pricing',
      'https://lovbase.dev/pricing?lang=zh',
      'https://lovbase.dev/templates',
      'https://lovbase.dev/templates?lang=zh',
    ])
  })
})
