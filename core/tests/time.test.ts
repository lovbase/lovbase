import { describe, expect, test } from 'bun:test'
import { timeAgo } from '../src/time'

const now = new Date('2026-09-20T12:00:00Z')
const ago = (ms: number, locale = 'en') => timeAgo(new Date(now.getTime() - ms), locale, now)

describe('timeAgo', () => {
  test('picks the largest unit that still counts, the way a person says it', () => {
    expect(ago(2 * 3600_000)).toBe('2 hours ago')
    expect(ago(90 * 60_000)).toBe('1 hour ago')
    expect(ago(3 * 24 * 3600_000)).toBe('3 days ago')
    expect(ago(45 * 24 * 3600_000)).toBe('last month')
    expect(ago(400 * 24 * 3600_000)).toBe('last year')
  })

  test('under a minute is "now", not "0 seconds ago"', () => {
    expect(ago(0)).toBe('this minute')
    expect(ago(30_000)).toBe('this minute')
  })

  test('speaks the locale it is given', () => {
    expect(ago(2 * 3600_000, 'zh-CN')).toContain('小时')
  })

  test('a clock skewed into the future reads as the future, not as a negative age', () => {
    expect(timeAgo(new Date(now.getTime() + 2 * 3600_000), 'en', now)).toBe('in 2 hours')
  })

  test('an unparseable date is empty rather than "Invalid Date"', () => {
    expect(timeAgo('not a date')).toBe('')
  })
})
