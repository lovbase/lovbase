/**
 * How long ago, in words.
 *
 * `Intl.RelativeTimeFormat` does the language, so this only has to pick the unit. It picks the
 * largest one that still gives a number of at least one, which is how a person says it: "2 hours
 * ago", not "127 minutes ago". Past the year mark the date itself is more use than the distance,
 * and a caller that wants that formats it directly.
 */
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

export function timeAgo(when: Date | string | number, locale = 'zh-CN', now: Date = new Date()): string {
  const then = when instanceof Date ? when : new Date(when)
  if (Number.isNaN(then.getTime())) return ''
  const seconds = Math.round((then.getTime() - now.getTime()) / 1000)
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    const n = Math.trunc(seconds / size)
    if (n !== 0) return fmt.format(n, unit)
  }
  // Under a minute, in either direction. "0 seconds ago" is not something anyone says.
  return fmt.format(0, 'minute')
}
