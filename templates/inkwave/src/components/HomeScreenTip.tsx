import { useEffect, useState } from 'react'
import { X, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'

const copy = {
  zh: {
    title: '添加到主屏幕，横屏玩更舒适',
    intro: '从主屏幕打开可在支持的浏览器中减少地址栏、标签栏占用。添加后请从桌面图标打开，再将手机横放。',
    apple:
      '苹果 iPhone / iPad：建议用 Safari 打开，点击“分享”→“添加到主屏幕”；若出现“作为 Web App 打开”，请开启。',
    android: '安卓：用 Chrome、Edge 等浏览器打开，点击菜单 ⋮ →“添加到主屏幕”或“安装应用”，按提示确认。',
    harmony:
      '鸿蒙 / 华为：在华为浏览器菜单中查找“添加到桌面”或“添加到主屏幕”，按提示确认。不同系统和浏览器版本入口可能不同。',
    note: '若在微信等应用内，请先选择“在浏览器打开”。部分浏览器仅创建快捷方式，仍会显示工具栏；这不是原生 App，也不保证离线可玩。',
    details: '查看安卓 / 苹果 / 鸿蒙操作步骤',
    close: '本次访问不再提示',
  },
  en: {
    title: 'Add to Home Screen for better landscape play',
    intro:
      'Launching from your home screen can reduce browser bars in supported browsers. Open the new icon, then rotate your phone sideways.',
    apple:
      'iPhone / iPad: Open in Safari, tap Share → Add to Home Screen. Enable “Open as Web App” if offered.',
    android:
      'Android: Open in Chrome, Edge or a similar browser. Tap the ⋮ menu → Add to Home screen or Install app, then confirm.',
    harmony:
      'HarmonyOS / Huawei: Look for Add to desktop or Add to Home screen in Huawei Browser’s menu. Availability and wording vary by browser and OS version.',
    note: 'Inside WeChat or another app? Choose Open in browser first. Some browsers only create a shortcut and keep their bars. This is not a native app and offline play is not guaranteed.',
    details: 'Android / Apple / HarmonyOS instructions',
    close: 'Dismiss for this visit',
  },
}

export function HomeScreenTip({ language, inMatch }: { language: 'en' | 'zh'; inMatch: boolean }) {
  const [mobile, setMobile] = useState(false)
  const [standalone, setStandalone] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const display = window.matchMedia('(display-mode: standalone)')
    const fullscreen = window.matchMedia('(display-mode: fullscreen)')
    const update = () => {
      setMobile(
        /Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(navigator.userAgent) ||
          (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent)),
      )
      setStandalone(
        display.matches ||
          fullscreen.matches ||
          Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
      )
    }
    try {
      setDismissed(sessionStorage.getItem('inkwave-home-tip-dismissed') === '1')
    } catch {
      /* Storage may be blocked. */
    }
    update()
    display.addEventListener('change', update)
    fullscreen.addEventListener('change', update)
    window.addEventListener('appinstalled', update)
    return () => {
      display.removeEventListener('change', update)
      fullscreen.removeEventListener('change', update)
      window.removeEventListener('appinstalled', update)
    }
  }, [])

  if (!mobile || standalone || dismissed || inMatch) return null
  const t = copy[language]
  return (
    <aside
      lang={language === 'zh' ? 'zh-CN' : 'en'}
      aria-label={t.title}
      className="dark fixed top-[max(0.75rem,env(safe-area-inset-top))] left-3 z-[60] max-h-[70dvh] w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain rounded-2xl border border-border/60 bg-background/80 p-4 text-foreground shadow-xl backdrop-blur-xl"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-2 right-2"
        aria-label={t.close}
        onClick={() => {
          setDismissed(true)
          try {
            sessionStorage.setItem('inkwave-home-tip-dismissed', '1')
          } catch {
            /* Optional persistence. */
          }
        }}
      >
        <X className="size-4" />
      </Button>
      <p className="flex items-center gap-2 pr-6 text-sm font-semibold">
        <Smartphone className="size-4 shrink-0" />
        {t.title}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t.intro}</p>
      <details className="mt-3 text-xs leading-relaxed">
        <summary className="cursor-pointer font-medium">{t.details}</summary>
        <ul className="mt-2 list-disc space-y-2 pl-4">
          <li>{t.android}</li>
          <li>{t.apple}</li>
          <li>{t.harmony}</li>
        </ul>
        <p className="mt-3 text-muted-foreground">{t.note}</p>
      </details>
    </aside>
  )
}
