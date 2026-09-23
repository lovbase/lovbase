import { useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Avatar } from './Avatar'
import { useT } from '../lib/i18n'

/** Matches AvatarsService. Checked here too so an obvious mistake never leaves the browser. */
const MAX_BYTES = 2 * 1024 * 1024
const TYPES = 'image/png,image/jpeg,image/webp,image/gif'

/**
 * Replacing the drawn identicon with a picture.
 *
 * The file is sent as the request body rather than a multipart form: there is one of it, and a
 * `File` is a valid body. The preview is a local object URL so the face changes the moment the
 * file is chosen, not a round trip later.
 */
export function AvatarPicker({ user }: { user: { name: string; email: string; image?: string | null } }) {
  const t = useT()
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const shown = preview ?? user.image ?? null

  async function pick(file: File | undefined) {
    if (!file) return
    setError('')
    if (file.size > MAX_BYTES) return setError(t('avatar.tooLarge', 'The avatar cannot be larger than 2MB'))
    const local = URL.createObjectURL(file)
    setPreview(local)
    setBusy(true)
    try {
      const res = await fetch('/api/avatar', { method: 'POST', body: file, headers: { 'content-type': file.type } })
      const body = await res.json().catch(() => null) as { error?: string } | null
      if (!res.ok) throw new Error(body?.error ?? `${t('avatar.uploadFailed', 'Upload failed')} (HTTP ${res.status})`)
      router.invalidate()
    } catch (e) {
      setPreview(null)
      setError(e instanceof Error ? e.message : t('avatar.uploadFailed', 'Upload failed'))
    } finally {
      setBusy(false)
      URL.revokeObjectURL(local)
      if (input.current) input.current.value = ''
    }
  }

  async function clear() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/avatar', { method: 'DELETE' })
      if (!res.ok) throw new Error(`${t('avatar.removeFailed', 'Remove failed')} (HTTP ${res.status})`)
      setPreview(null)
      router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('avatar.removeFailed', 'Remove failed'))
    } finally { setBusy(false) }
  }

  return (
    <div className="flex items-center gap-4">
      <Avatar src={shown} seed={user.email} name={user.name || user.email} size={56} className="rounded-xl" />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <button onClick={() => input.current?.click()} disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-edge text-[12.5px] text-fg-mid hover:text-fg hover:border-edge-strong disabled:opacity-50 transition-colors cursor-pointer">
            {busy ? t('avatar.uploading', 'Uploading…') : shown ? t('avatar.change', 'Change picture') : t('avatar.upload', 'Upload avatar')}
          </button>
          {shown && (
            <button onClick={clear} disabled={busy}
              className="px-3 py-1.5 rounded-lg text-[12.5px] text-fg-dim hover:text-fg disabled:opacity-50 cursor-pointer">
              {t('avatar.reset', 'Restore default')}
            </button>
          )}
        </div>
        <p className="text-[11.5px] text-fg-dim mt-1.5">
          {error || t('avatar.hint', 'PNG, JPEG, WebP or GIF, up to 2MB. Without one, a pattern generated from your email is used.')}
        </p>
      </div>
      <input ref={input} type="file" accept={TYPES} className="hidden"
        onChange={(e) => pick(e.target.files?.[0])} />
    </div>
  )
}
