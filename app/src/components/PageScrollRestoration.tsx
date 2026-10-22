import { useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import { capturePagePosition, pageMemory, pagePositionKey, type PagePosition } from '../lib/page-navigation'

/** Restores only the window and explicitly marked page-level containers. */
export function PageScrollRestoration() {
  const router = useRouter()
  useEffect(() => {
    const memory = pageMemory()
    let active = window.location.pathname + window.location.search + window.location.hash
    let restoring = false,
      navigating = false,
      timer: ReturnType<typeof setTimeout> | undefined
    let frame = 0
    const previous = history.scrollRestoration
    history.scrollRestoration = 'manual'
    const save = () => {
      if (!restoring && !navigating) memory.save(active, capturePagePosition())
    }
    const stop = () => {
      cancelAnimationFrame(frame)
      restoring = false
    }
    const restore = (position?: PagePosition) => {
      stop()
      if (!position) return // Router handles new-page top/hash scrolling.
      restoring = true
      const deadline = performance.now() + 2000
      const apply = () => {
        let done = true
        window.scrollTo({ left: position.window.x, top: position.window.y, behavior: 'instant' })
        done = Math.abs(window.scrollY - position.window.y) < 1 && Math.abs(window.scrollX - position.window.x) < 1
        for (const [id, point] of Object.entries(position.areas)) {
          const area = document.querySelector<HTMLElement>(`[data-page-scroll="${id}"]`)
          if (!area) {
            done = false
            continue
          }
          area.scrollTo({ left: point.x, top: point.y, behavior: 'instant' })
          done = done && Math.abs(area.scrollTop - point.y) < 1 && Math.abs(area.scrollLeft - point.x) < 1
        }
        if (!done && performance.now() < deadline) frame = requestAnimationFrame(apply)
        else restoring = false
      }
      frame = requestAnimationFrame(apply)
    }
    const before = router.subscribe('onBeforeLoad', ({ fromLocation, toLocation }) => {
      save()
      if (fromLocation?.href === toLocation.href) return // Loader invalidation is not a navigation.
      if (fromLocation && pagePositionKey(fromLocation.href) !== pagePositionKey(toLocation.href)) {
        if (toLocation.pathname === '/pricing') memory.enterPricing(fromLocation.href)
      }
      navigating = true
      stop()
      clearTimeout(timer)
    })
    const rendered = router.subscribe('onRendered', ({ toLocation }) => {
      active = toLocation.href
      navigating = false
      if (/^\/(login|signup)(?:\/|$)/.test(toLocation.pathname)) memory.clear()
      restore(memory.load(active))
    })
    const onScroll = (event: Event) => {
      if (
        event.target !== document &&
        !(event.target instanceof HTMLElement && event.target.hasAttribute('data-page-scroll'))
      )
        return
      if (restoring || navigating) return
      clearTimeout(timer)
      timer = setTimeout(save, 120)
    }
    const hide = () => {
      clearTimeout(timer)
      save()
    }
    document.addEventListener('scroll', onScroll, true)
    const inputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
    for (const name of inputEvents) window.addEventListener(name, stop, { passive: true })
    window.addEventListener('pagehide', hide)
    if (/^\/(login|signup)(?:\/|$)/.test(window.location.pathname)) memory.clear()
    restore(memory.load(active))
    return () => {
      before()
      rendered()
      clearTimeout(timer)
      stop()
      document.removeEventListener('scroll', onScroll, true)
      for (const name of inputEvents) window.removeEventListener(name, stop)
      window.removeEventListener('pagehide', hide)
      history.scrollRestoration = previous
    }
  }, [router])
  return null
}
