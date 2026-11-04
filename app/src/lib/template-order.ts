/**
 * Gallery order: keys the admin positioned first, in that order; everything else after, in the
 * order it came in. Shared so the admin list and the gallery cannot disagree.
 */
export function byPosition<T>(items: T[], key: (item: T) => string, order: Record<string, number>): T[] {
  const at = (item: T) => order[key(item)] ?? Number.MAX_SAFE_INTEGER
  return items.map((item, i) => ({ item, i, p: at(item) })).sort((a, b) => a.p - b.p || a.i - b.i).map((x) => x.item)
}
