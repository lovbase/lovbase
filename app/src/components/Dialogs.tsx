import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useT } from '../lib/i18n'

/**
 * The three browser dialogs, rebuilt out of the component library.
 *
 * `alert`, `confirm` and `prompt` are the only pieces of chrome the product did not draw itself:
 * a Chrome-coloured box that says "lovbase.dev says", in the system font, ignoring the theme, and
 * freezing the tab until it is answered. It also made the caller synchronous, which is why the
 * call sites are one-liners — so the replacement is imperative too, and awaits instead of blocks.
 *
 *   const { confirm } = useDialogs()
 *   if (!(await confirm({ title: 'Delete?', destructive: true }))) return
 *
 * Confirm and alert are `alertdialog`s (no click-outside dismissal — an answer is required);
 * prompt is an ordinary dialog with an input, and Enter submits.
 */

type Kind = 'alert' | 'confirm' | 'prompt'

type Ask = {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Paints the confirming button as a destructive action. */
  destructive?: boolean
}
type AskPrompt = Ask & { label?: string; defaultValue?: string; placeholder?: string }

type Request = AskPrompt & { kind: Kind }

type Dialogs = {
  alert: (ask: Ask | string) => Promise<void>
  confirm: (ask: Ask | string) => Promise<boolean>
  prompt: (ask: AskPrompt | string) => Promise<string | null>
}

const Ctx = createContext<Dialogs | null>(null)

export function useDialogs() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useDialogs needs <DialogsProvider>')
  return ctx
}

const asAsk = (ask: Ask | AskPrompt | string) => (typeof ask === 'string' ? { title: ask } : ask)

export function DialogsProvider({ children }: { children: React.ReactNode }) {
  const t = useT()
  // The request stays mounted while the dialog animates out, so `open` is what closes it.
  const [req, setReq] = useState<Request | null>(null)
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const resolve = useRef<(v: any) => void>(() => {})

  const ask = useCallback((kind: Kind, a: Ask | AskPrompt | string) => {
    const next = { kind, ...asAsk(a) } as Request
    // Whatever was on screen is answered as a dismissal rather than left hanging forever.
    resolve.current(kind === 'prompt' ? null : false)
    setReq(next)
    setValue(next.defaultValue ?? '')
    setOpen(true)
    return new Promise<any>((r) => { resolve.current = r })
  }, [])

  const close = useCallback((answer: unknown) => {
    setOpen(false)
    const r = resolve.current
    resolve.current = () => {}
    r(answer)
  }, [])

  const api = useMemo<Dialogs>(() => ({
    alert: (a) => ask('alert', a).then(() => undefined),
    confirm: (a) => ask('confirm', a),
    prompt: (a) => ask('prompt', a),
  }), [ask])

  const cancelLabel = req?.cancelLabel ?? t('dialog.cancel', 'Cancel')
  const confirmLabel = req?.confirmLabel ?? t('dialog.ok', 'OK')

  return (
    <Ctx.Provider value={api}>
      {children}
      {req?.kind === 'prompt' ? (
        <Dialog open={open} onOpenChange={(o) => { if (!o) close(null) }}>
          <DialogContent showCloseButton={false}>
            <form onSubmit={(e) => { e.preventDefault(); close(value.trim() ? value : null) }} className="contents">
              <DialogHeader>
                <DialogTitle>{req.title}</DialogTitle>
                {req.description && <DialogDescription>{req.description}</DialogDescription>}
              </DialogHeader>
              <label className="block">
                {req.label && <span className="mb-1.5 block font-mono text-[10.5px] tracking-[.12em] text-muted-foreground uppercase">{req.label}</span>}
                <Input autoFocus value={value} placeholder={req.placeholder} onChange={(e) => setValue(e.target.value)} />
              </label>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => close(null)}>{cancelLabel}</Button>
                <Button type="submit" disabled={!value.trim()}>{confirmLabel}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : (
        <AlertDialog open={open} onOpenChange={(o) => { if (!o) close(req?.kind === 'confirm' ? false : undefined) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{req?.title}</AlertDialogTitle>
              {req?.description && <AlertDialogDescription>{req.description}</AlertDialogDescription>}
            </AlertDialogHeader>
            <AlertDialogFooter>
              {req?.kind === 'confirm' && (
                <Button variant="outline" onClick={() => close(false)}>{cancelLabel}</Button>
              )}
              <Button autoFocus variant={req?.destructive ? 'destructive' : 'default'}
                onClick={() => close(req?.kind === 'confirm' ? true : undefined)}>
                {req?.kind === 'confirm' ? confirmLabel : (req?.confirmLabel ?? t('dialog.gotIt', 'Got it'))}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </Ctx.Provider>
  )
}
