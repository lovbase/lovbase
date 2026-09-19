import { useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { useRouter } from '@tanstack/react-router'
import { Popover } from '@base-ui-components/react/popover'
import { setShare } from '../functions'

export function ShareChip({ projectId, token, disabled }: { projectId: string; token: string | null; disabled: boolean }) {
  const router = useRouter()
  const toggle = useServerFn(setShare)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const url = token && typeof location !== 'undefined' ? `${location.origin}/share/${token}` : ''

  async function set(enabled: boolean) {
    setBusy(true)
    try { await toggle({ data: { projectId, enabled } }) } finally { setBusy(false); router.invalidate() }
  }

  return (
    <Popover.Root>
      <Popover.Trigger disabled={disabled}
        className={`px-3 py-1.5 text-[12.5px] rounded-lg border transition-colors cursor-pointer
                    disabled:opacity-40 disabled:cursor-not-allowed ${
          token ? 'border-accent/40 text-accent-soft hover:bg-accent/5' : 'border-edge text-fg-mid hover:text-fg hover:border-edge-strong'
        }`}>
        {token ? '已分享' : '分享'}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end">
          <Popover.Popup className="w-[22rem] bg-panel border border-edge-strong rounded-xl p-4 shadow-2xl text-sm">
            <Popover.Title className="font-mono text-[10.5px] uppercase tracking-[.14em] text-fg-dim mb-2">
              share link
            </Popover.Title>
            {token ? (
              <>
                <p className="text-fg-mid text-[13px] mb-3">拿到链接的人可以查看和录入数据,不能改结构。</p>
                <div className="flex gap-2">
                  <input readOnly value={url} onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 min-w-0 px-2.5 py-1.5 bg-ink border border-edge rounded-md font-mono text-[12px] text-fg" />
                  <button onClick={() => navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })}
                    className="px-3 py-1.5 bg-accent text-on-accent rounded-md text-[12.5px] cursor-pointer hover:bg-accent-soft">
                    {copied ? '已复制' : '复制'}
                  </button>
                </div>
                <button onClick={() => set(false)} disabled={busy}
                  className="mt-3 text-[12px] font-mono text-fg-dim hover:text-accent-soft cursor-pointer">
                  关闭分享
                </button>
              </>
            ) : (
              <>
                <p className="text-fg-mid text-[13px] mb-3">生成一个公开链接,别人无需登录就能用这个应用。</p>
                <button onClick={() => set(true)} disabled={busy}
                  className="px-3.5 py-2 bg-accent text-on-accent rounded-lg text-[13px] font-medium cursor-pointer hover:bg-accent-soft disabled:opacity-50">
                  开启分享
                </button>
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
